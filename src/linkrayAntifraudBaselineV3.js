// LinkRay AntiFraud baseline snapshots v3

function rows(value) {
  return Array.isArray(value) ? value : (value?.rows || []);
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLinkRayAntifraudBaselineV3({
  query,
  maxFetch,
  logger = console,
} = {}) {
  if (typeof query !== 'function') {
    throw new Error('BaselineV3 requires query()');
  }
  if (typeof maxFetch !== 'function') {
    throw new Error('BaselineV3 requires maxFetch()');
  }

  const log = (...args) => logger?.log?.('[LinkRay BaselineV3]', ...args);
  const warn = (...args) => logger?.warn?.('[LinkRay BaselineV3]', ...args);
  const error = (...args) => logger?.error?.('[LinkRay BaselineV3]', ...args);

  let schemaPromise = null;
  let timer = null;
  let repairRunning = false;
  let snapshotRunning = false;

  async function ensureSchema() {
    if (schemaPromise) return schemaPromise;

    schemaPromise = (async () => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS public.lr_antifraud_participant_snapshots (
          id bigserial PRIMARY KEY,
          channel_id bigint NOT NULL,
          max_chat_id text NOT NULL,
          participants_count integer NOT NULL,
          source text NOT NULL DEFAULT 'antifraud_poll',
          raw jsonb NOT NULL DEFAULT '{}'::jsonb,
          captured_at timestamptz NOT NULL DEFAULT now()
        )`,
        `CREATE INDEX IF NOT EXISTS
          lr_antifraud_participant_snapshots_channel_time_idx
          ON public.lr_antifraud_participant_snapshots(
            channel_id,
            captured_at DESC
          )`,
        `ALTER TABLE public.lr_antifraud_waves
          ADD COLUMN IF NOT EXISTS participants_before_source text`,
        `ALTER TABLE public.lr_antifraud_waves
          ADD COLUMN IF NOT EXISTS participants_before_captured_at timestamptz`,
        `ALTER TABLE public.lr_antifraud_waves
          ADD COLUMN IF NOT EXISTS participants_after_captured_at timestamptz`,
        `ALTER TABLE public.lr_antifraud_events
          ADD COLUMN IF NOT EXISTS country_evidence text`,
        `ALTER TABLE public.lr_antifraud_events
          ADD COLUMN IF NOT EXISTS country_name text`,
        `ALTER TABLE public.lr_antifraud_events
          ADD COLUMN IF NOT EXISTS country_source text`,
      ];

      for (const statement of statements) {
        await query(statement);
      }
    })().catch((schemaError) => {
      schemaPromise = null;
      throw schemaError;
    });

    return schemaPromise;
  }

  function participantCount(data) {
    const source = data?.chat || data || {};
    const candidates = [
      source.participants_count,
      source.members_count,
      source.subscribers_count,
      source.participant_count,
      source.membersCount,
      source.subscribersCount,
    ];

    for (const candidate of candidates) {
      const value = Number(candidate);
      if (Number.isFinite(value) && value >= 0) {
        return Math.round(value);
      }
    }
    return null;
  }

  async function fetchCount(maxChatId) {
    const data = await maxFetch(
      `/chats/${encodeURIComponent(String(maxChatId))}`,
    );
    return { count: participantCount(data), raw: data };
  }

  async function saveSnapshot(
    channelId,
    maxChatId,
    count,
    source = 'antifraud_poll',
    raw = {},
  ) {
    if (!Number.isFinite(Number(count)) || Number(count) < 0) {
      return null;
    }

    const latest = rows(await query(`
      SELECT participants_count, captured_at
      FROM public.lr_antifraud_participant_snapshots
      WHERE channel_id=$1
      ORDER BY captured_at DESC
      LIMIT 1
    `, [channelId]))[0];

    const age = latest?.captured_at
      ? Date.now() - new Date(latest.captured_at).getTime()
      : Number.POSITIVE_INFINITY;

    if (
      latest &&
      num(latest.participants_count, -1) === Number(count) &&
      age < 120_000
    ) {
      return latest;
    }

    return rows(await query(`
      INSERT INTO public.lr_antifraud_participant_snapshots(
        channel_id,
        max_chat_id,
        participants_count,
        source,
        raw,
        captured_at
      )
      VALUES($1,$2,$3,$4,$5::jsonb,now())
      RETURNING *
    `, [
      channelId,
      String(maxChatId),
      Math.round(Number(count)),
      clean(source, 100),
      JSON.stringify(raw || {}),
    ]))[0] || null;
  }

  async function snapshotEnabledChannels() {
    if (snapshotRunning) return;
    snapshotRunning = true;

    try {
      const channels = rows(await query(`
        SELECT channel_id, max_chat_id
        FROM public.lr_antifraud_channels
        WHERE enabled=true
        ORDER BY channel_id
      `));

      for (const channel of channels) {
        try {
          const current = await fetchCount(channel.max_chat_id);
          if (current.count !== null) {
            await saveSnapshot(
              channel.channel_id,
              channel.max_chat_id,
              current.count,
              'antifraud_poll',
              current.raw,
            );
          }
        } catch (snapshotError) {
          warn(
            `snapshot channel ${channel.channel_id} failed:`,
            snapshotError?.message || snapshotError,
          );
        }
        await sleep(120);
      }
    } finally {
      snapshotRunning = false;
    }
  }

  async function tableExists(name) {
    return Boolean(rows(await query(`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name=$1
      LIMIT 1
    `, [name]))[0]);
  }

  async function antiSnapshotBefore(wave) {
    return rows(await query(`
      SELECT participants_count, captured_at, source
      FROM public.lr_antifraud_participant_snapshots
      WHERE channel_id=$1
        AND captured_at < $2
        AND captured_at >= $2::timestamptz - interval '30 minutes'
      ORDER BY captured_at DESC
      LIMIT 1
    `, [wave.channel_id, wave.started_at]))[0] || null;
  }

  async function antiSnapshotAfter(wave) {
    const boundary = wave.ended_at || wave.last_event_at || wave.started_at;
    return rows(await query(`
      SELECT participants_count, captured_at, source
      FROM public.lr_antifraud_participant_snapshots
      WHERE channel_id=$1
        AND captured_at >= $2
        AND captured_at <= $2::timestamptz + interval '30 minutes'
      ORDER BY captured_at ASC
      LIMIT 1
    `, [wave.channel_id, boundary]))[0] || null;
  }

  async function analyticsSnapshotBefore(wave) {
    if (!(await tableExists('lr_channel_analytics_snapshots'))) {
      return null;
    }

    const channel = rows(await query(`
      SELECT link, max_chat_id
      FROM public.channels
      WHERE id=$1
      LIMIT 1
    `, [wave.channel_id]))[0] || {};

    const link = clean(channel.link, 1500);
    const maxChatId = String(
      wave.max_chat_id || channel.max_chat_id || '',
    );

    return rows(await query(`
      SELECT
        subscribers AS participants_count,
        captured_at,
        'analytics_snapshot'::text AS source
      FROM public.lr_channel_analytics_snapshots
      WHERE captured_at < $1
        AND captured_at >= $1::timestamptz - interval '45 minutes'
        AND (
          raw #>> '{chat,chat_id}'=$2
          OR raw #>> '{chat,id}'=$2
          OR raw #>> '{chat,chat,id}'=$2
          OR raw #>> '{chat,channel_id}'=$2
          OR ($3<>'' AND link=$3)
        )
      ORDER BY captured_at DESC
      LIMIT 1
    `, [wave.started_at, maxChatId, link]).catch(() => []))[0] || null;
  }

  async function waveCounts(waveId) {
    return rows(await query(`
      SELECT
        count(*) FILTER (
          WHERE event_type='join'
        )::integer AS joined_count,
        count(*) FILTER (
          WHERE event_type='leave'
        )::integer AS removed_count
      FROM public.lr_antifraud_events
      WHERE wave_id=$1
    `, [waveId]))[0] || {
      joined_count: 0,
      removed_count: 0,
    };
  }

  async function fixWave(waveId) {
    await ensureSchema();

    let wave = rows(await query(`
      SELECT *
      FROM public.lr_antifraud_waves
      WHERE id=$1
      LIMIT 1
    `, [waveId]))[0];

    if (!wave) return null;

    const counts = await waveCounts(wave.id);
    const joined = num(counts.joined_count);
    const removed = num(counts.removed_count);

    let currentCount = null;

    try {
      const current = await fetchCount(wave.max_chat_id);
      currentCount = current.count;
      if (currentCount !== null) {
        await saveSnapshot(
          wave.channel_id,
          wave.max_chat_id,
          currentCount,
          'wave_repair_current',
          current.raw,
        );
      }
    } catch (currentError) {
      warn(
        `wave ${wave.id}: current participant count failed:`,
        currentError?.message || currentError,
      );
    }

    const beforeAnti = await antiSnapshotBefore(wave);
    const beforeAnalytics = beforeAnti
      ? null
      : await analyticsSnapshotBefore(wave);
    const afterSnapshot = await antiSnapshotAfter(wave);

    let participantsAfter = afterSnapshot
      ? num(afterSnapshot.participants_count)
      : currentCount;

    if (participantsAfter === null || participantsAfter === undefined) {
      participantsAfter = wave.participants_after === null
        ? null
        : num(wave.participants_after);
    }

    let participantsBefore = null;
    let beforeSource = null;
    let beforeCapturedAt = null;
    const preSnapshot = beforeAnti || beforeAnalytics;

    if (preSnapshot) {
      participantsBefore = num(preSnapshot.participants_count);
      beforeSource = clean(preSnapshot.source || 'snapshot', 100);
      beforeCapturedAt = preSnapshot.captured_at || null;
    } else if (participantsAfter !== null) {
      participantsBefore = Math.max(
        0,
        participantsAfter - joined + removed,
      );
      beforeSource = 'reconstructed_from_current_and_wave_events';
    } else if (
      wave.participants_before !== null &&
      wave.participants_before !== undefined
    ) {
      participantsBefore = num(wave.participants_before);
      beforeSource = wave.participants_before_source || 'legacy';
      beforeCapturedAt = wave.participants_before_captured_at || null;
    }

    wave = rows(await query(`
      UPDATE public.lr_antifraud_waves
      SET
        participants_before=$2,
        participants_after=$3,
        participants_before_source=$4,
        participants_before_captured_at=$5,
        participants_after_captured_at=CASE
          WHEN $3 IS NULL THEN participants_after_captured_at
          ELSE now()
        END,
        joined_count=$6,
        removed_count=$7,
        updated_at=now()
      WHERE id=$1
      RETURNING *
    `, [
      wave.id,
      participantsBefore,
      participantsAfter,
      beforeSource,
      beforeCapturedAt,
      joined,
      removed,
    ]))[0] || wave;

    log(
      `wave ${wave.id}: before=${participantsBefore} ` +
      `after=${participantsAfter} source=${beforeSource}`,
    );

    return wave;
  }

  async function fixRecent(hours = 24, limit = 100) {
    if (repairRunning) return 0;
    repairRunning = true;

    try {
      const waves = rows(await query(`
        SELECT id
        FROM public.lr_antifraud_waves
        WHERE started_at>=now()-($1::text || ' hours')::interval
        ORDER BY started_at DESC
        LIMIT $2
      `, [
        String(Math.max(1, num(hours, 24))),
        Math.max(1, num(limit, 100)),
      ]));

      for (const wave of waves) {
        try {
          await fixWave(wave.id);
        } catch (repairError) {
          error(
            `wave ${wave.id} repair failed:`,
            repairError?.stack || repairError?.message || repairError,
          );
        }
      }
      return waves.length;
    } finally {
      repairRunning = false;
    }
  }

  async function start() {
    await ensureSchema();
    await snapshotEnabledChannels();

    setTimeout(() => {
      fixRecent(24, 100).catch((repairError) => {
        error(
          'startup repair failed:',
          repairError?.stack || repairError?.message || repairError,
        );
      });
    }, 4_000).unref?.();

    if (!timer) {
      timer = setInterval(() => {
        snapshotEnabledChannels().catch((snapshotError) => {
          error(
            'snapshot timer failed:',
            snapshotError?.stack || snapshotError?.message || snapshotError,
          );
        });

        fixRecent(2, 30).catch((repairError) => {
          error(
            'repair timer failed:',
            repairError?.stack || repairError?.message || repairError,
          );
        });
      }, 15_000);

      timer.unref?.();
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    version: '3.0.0',
    ensureSchema,
    snapshotEnabledChannels,
    fixWave,
    fixRecent,
    start,
    stop,
  };
}

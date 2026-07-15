// LinkRay AntiFraud Cohort Engine v2
// Detects fake-human bot farms as a cohort. MAX is_bot remains a separate official-bot flag.

function rows(value) {
  return Array.isArray(value) ? value : (value?.rows || []);
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function json(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value)))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return 0;

  const index = clamp((sortedValues.length - 1) * fraction, 0, sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sortedValues[lower];

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function coefficientOfVariation(values) {
  if (values.length < 2) return 99;

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return 99;

  const variance = values.reduce(
    (sum, value) => sum + ((value - mean) ** 2),
    0,
  ) / values.length;

  return Math.sqrt(variance) / mean;
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '')
    .replace(/\d+$/g, '');
}

function nameShape(value) {
  const tokens = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const joined = tokens.join('');
  const hasCyrillic = /[а-яё]/i.test(joined);
  const hasLatin = /[a-z]/i.test(joined);
  const script = hasCyrillic && hasLatin
    ? 'mixed'
    : hasCyrillic
      ? 'cyr'
      : hasLatin
        ? 'lat'
        : 'other';

  return `${script}:${tokens.length}`;
}

function memberId(member) {
  return String(
    member?.user_id ??
    member?.userId ??
    member?.id ??
    '',
  ).trim();
}

function memberCollection(data) {
  const candidates = [
    data?.members,
    data?.chat?.members,
    data?.users,
    data?.items,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function profileSnapshot(member) {
  return {
    description: member?.description ?? null,
    join_time: member?.join_time ?? member?.joinTime ?? null,
    last_access_time: member?.last_access_time ?? member?.lastAccessTime ?? null,
    permissions: Array.isArray(member?.permissions) ? member.permissions : [],
    alias: member?.alias ?? null,
  };
}

export function createLinkRayCohortEngine({
  query,
  maxFetch,
  logger = console,
  refreshWave = null,
  onWaveScored = null,
} = {}) {
  if (typeof query !== 'function') {
    throw new Error('Cohort engine requires query()');
  }

  if (typeof maxFetch !== 'function') {
    throw new Error('Cohort engine requires maxFetch()');
  }

  const log = (...args) => logger?.log?.('[LinkRay CohortV2]', ...args);
  const warn = (...args) => logger?.warn?.('[LinkRay CohortV2]', ...args);
  const error = (...args) => logger?.error?.('[LinkRay CohortV2]', ...args);

  let schemaPromise = null;
  let timer = null;
  let timerTick = 0;
  const runningWaves = new Set();

  async function ensureSchema() {
    if (schemaPromise) return schemaPromise;

    schemaPromise = (async () => {
      const statements = [
        `ALTER TABLE public.lr_antifraud_events
           ADD COLUMN IF NOT EXISTS bot_probability integer NOT NULL DEFAULT 0`,
        `ALTER TABLE public.lr_antifraud_events
           ADD COLUMN IF NOT EXISTS bot_class text NOT NULL DEFAULT 'unknown'`,
        `ALTER TABLE public.lr_antifraud_events
           ADD COLUMN IF NOT EXISTS cohort_signals jsonb NOT NULL DEFAULT '[]'::jsonb`,
        `ALTER TABLE public.lr_antifraud_events
           ADD COLUMN IF NOT EXISTS cohort_strong_signals integer NOT NULL DEFAULT 0`,
        `ALTER TABLE public.lr_antifraud_events
           ADD COLUMN IF NOT EXISTS profile_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`,
        `ALTER TABLE public.lr_antifraud_events
           ADD COLUMN IF NOT EXISTS profile_enriched_at timestamptz`,
        `ALTER TABLE public.lr_antifraud_waves
           ADD COLUMN IF NOT EXISTS probable_bot_count integer NOT NULL DEFAULT 0`,
        `ALTER TABLE public.lr_antifraud_waves
           ADD COLUMN IF NOT EXISTS high_confidence_bot_count integer NOT NULL DEFAULT 0`,
        `ALTER TABLE public.lr_antifraud_waves
           ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0`,
        `ALTER TABLE public.lr_antifraud_waves
           ADD COLUMN IF NOT EXISTS official_bot_count integer NOT NULL DEFAULT 0`,
        `ALTER TABLE public.lr_antifraud_waves
           ADD COLUMN IF NOT EXISTS cohort_confidence numeric NOT NULL DEFAULT 0`,
        `ALTER TABLE public.lr_antifraud_waves
           ADD COLUMN IF NOT EXISTS cohort_summary jsonb NOT NULL DEFAULT '{}'::jsonb`,
        `CREATE INDEX IF NOT EXISTS lr_antifraud_events_bot_class_idx
           ON public.lr_antifraud_events(
             wave_id,
             bot_class,
             removal_eligible DESC,
             bot_probability DESC
           )`,
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

  async function waveById(waveId) {
    return rows(await query(
      `SELECT *
       FROM public.lr_antifraud_waves
       WHERE id=$1
       LIMIT 1`,
      [waveId],
    ))[0] || null;
  }

  async function fetchWaveEvents(waveId) {
    return rows(await query(
      `SELECT *
       FROM public.lr_antifraud_events
       WHERE wave_id=$1
         AND event_type='join'
       ORDER BY event_at ASC, id ASC`,
      [waveId],
    ));
  }

  async function enrichWaveMembers(wave, events) {
    const candidates = events
      .filter((event) => event.user_id)
      .filter((event) => {
        if (!event.profile_enriched_at) return true;

        const ageMs = Date.now() - new Date(event.profile_enriched_at).getTime();
        return !Number.isFinite(ageMs) || ageMs > 15 * 60_000;
      })
      .slice(0, 500);

    for (let index = 0; index < candidates.length; index += 50) {
      const chunk = candidates.slice(index, index + 50);
      const userIds = chunk.map((event) => String(event.user_id));

      try {
        const data = await maxFetch(
          `/chats/${encodeURIComponent(String(wave.max_chat_id))}/members`,
          {
            query: {
              user_ids: userIds,
            },
          },
        );

        const members = memberCollection(data);
        const byId = new Map(
          members
            .map((member) => [memberId(member), member])
            .filter(([id]) => Boolean(id)),
        );

        for (const event of chunk) {
          const member = byId.get(String(event.user_id));
          if (!member) continue;

          const firstName = String(
            member?.first_name ??
            member?.firstName ??
            '',
          ).trim();

          const lastName = String(
            member?.last_name ??
            member?.lastName ??
            '',
          ).trim();

          const displayName = String(
            `${firstName} ${lastName}`.trim() ||
            member?.name ||
            event.display_name ||
            `MAX ID ${event.user_id}`,
          ).trim();

          const username = String(
            member?.username ??
            '',
          ).replace(/^@/, '').trim();

          const avatarUrl = String(
            member?.avatar_url ??
            member?.full_avatar_url ??
            '',
          ).trim();

          const lastActivity = toIso(
            member?.last_activity_time ??
            member?.lastActivityTime ??
            null,
          );

          await query(
            `UPDATE public.lr_antifraud_events
             SET
               first_name=COALESCE(NULLIF($2,''),first_name),
               last_name=COALESCE(NULLIF($3,''),last_name),
               display_name=COALESCE(NULLIF($4,''),display_name),
               normalized_name=COALESCE(NULLIF($5,''),normalized_name),
               username=COALESCE(NULLIF($6,''),username),
               avatar_url=COALESCE(NULLIF($7,''),avatar_url),
               is_bot=$8,
               is_admin=$9,
               is_owner=$10,
               last_activity_time=COALESCE($11::timestamptz,last_activity_time),
               profile_snapshot=$12::jsonb,
               profile_enriched_at=now(),
               updated_at=now()
             WHERE id=$1`,
            [
              event.id,
              firstName,
              lastName,
              displayName,
              normalizeName(displayName),
              username,
              avatarUrl,
              Boolean(member?.is_bot ?? member?.isBot),
              Boolean(member?.is_admin ?? member?.isAdmin),
              Boolean(member?.is_owner ?? member?.isOwner),
              lastActivity,
              JSON.stringify(profileSnapshot(member)),
            ],
          );
        }
      } catch (fetchError) {
        warn(
          `member enrichment failed for wave ${wave.id}:`,
          fetchError?.message || fetchError,
        );
      }

      await sleep(120);
    }
  }

  function analyzeWave(events, wave, whitelist) {
    const count = events.length;
    const times = events.map((event) => new Date(event.event_at).getTime());
    const gaps = [];

    for (let index = 1; index < times.length; index += 1) {
      const gap = Math.max(0, (times[index] - times[index - 1]) / 1000);
      gaps.push(gap);
    }

    const sortedGaps = [...gaps].sort((left, right) => left - right);
    const medianGap = percentile(sortedGaps, 0.5);
    const p80Gap = percentile(sortedGaps, 0.8);
    const p90Gap = percentile(sortedGaps, 0.9);
    const cadenceCv = coefficientOfVariation(gaps);

    const firstAt = times[0] || Date.now();
    const lastAt = times[times.length - 1] || firstAt;
    const durationSeconds = Math.max(1, (lastAt - firstAt) / 1000);
    const ratePerMinute = count / Math.max(1 / 60, durationSeconds / 60);

    const localGap = events.map((event, index) => {
      const before = index > 0
        ? Math.max(0, (times[index] - times[index - 1]) / 1000)
        : Number.POSITIVE_INFINITY;

      const after = index < times.length - 1
        ? Math.max(0, (times[index + 1] - times[index]) / 1000)
        : Number.POSITIVE_INFINITY;

      return Math.min(before, after);
    });

    const denseShare = count
      ? localGap.filter((gap) => gap <= 3).length / count
      : 0;

    const noUsernameShare = count
      ? events.filter((event) => !String(event.username || '').trim()).length / count
      : 0;

    const noActivityShare = count
      ? events.filter((event) => !event.last_activity_time).length / count
      : 0;

    const signatureCounts = new Map();
    const shapeCounts = new Map();
    const exactNameCounts = new Map();

    for (const event of events) {
      const snapshot = json(event.profile_snapshot, {});
      const shape = nameShape(event.display_name);
      const signature = [
        event.username ? 'u1' : 'u0',
        event.last_activity_time ? 'a1' : 'a0',
        snapshot?.description ? 'd1' : 'd0',
        shape,
      ].join('|');

      signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);
      shapeCounts.set(shape, (shapeCounts.get(shape) || 0) + 1);

      const normalized = normalizeName(event.display_name);
      if (normalized) {
        exactNameCounts.set(normalized, (exactNameCounts.get(normalized) || 0) + 1);
      }
    }

    const dominantSignatureCount = Math.max(0, ...signatureCounts.values());
    const dominantShapeCount = Math.max(0, ...shapeCounts.values());
    const dominantSignatureShare = count ? dominantSignatureCount / count : 0;
    const dominantShapeShare = count ? dominantShapeCount / count : 0;

    const numericIds = events
      .map((event) => {
        const value = String(event.user_id || '');
        return /^\d+$/.test(value)
          ? { eventId: event.id, value: BigInt(value) }
          : null;
      })
      .filter(Boolean)
      .sort((left, right) => (
        left.value < right.value ? -1 : left.value > right.value ? 1 : 0
      ));

    const nearestIdDistance = new Map();

    for (let index = 0; index < numericIds.length; index += 1) {
      const current = numericIds[index];
      const distances = [];

      if (index > 0) {
        distances.push(current.value - numericIds[index - 1].value);
      }

      if (index < numericIds.length - 1) {
        distances.push(numericIds[index + 1].value - current.value);
      }

      const nearest = distances.length
        ? distances.reduce((best, value) => (value < best ? value : best))
        : null;

      nearestIdDistance.set(current.eventId, nearest);
    }

    const baseline = json(wave.baseline, {});
    const anomalyRatio = num(baseline?.ratio, 0);

    const machineBurst = Boolean(
      count >= 12 &&
      medianGap <= 3.5 &&
      denseShare >= 0.65
    );

    const veryDenseBurst = Boolean(
      count >= 20 &&
      medianGap <= 1.8 &&
      denseShare >= 0.80
    );

    const anomalousFlow = Boolean(
      anomalyRatio >= 4 ||
      ratePerMinute >= 12
    );

    const profileHomogeneous = Boolean(
      count >= 12 &&
      noUsernameShare >= 0.72 &&
      noActivityShare >= 0.72
    );

    const regularCadence = Boolean(
      gaps.length >= 10 &&
      cadenceCv <= 1.15 &&
      p90Gap <= 8
    );

    let confidence = 0;

    if (machineBurst) confidence += 0.28;
    if (veryDenseBurst) confidence += 0.12;
    if (count >= 30) confidence += 0.12;
    if (anomalousFlow) confidence += 0.12;
    if (profileHomogeneous) confidence += 0.18;
    if (dominantSignatureShare >= 0.65) confidence += 0.08;
    if (regularCadence) confidence += 0.06;
    if (noUsernameShare >= 0.85) confidence += 0.04;

    confidence = clamp(confidence, 0, 1);

    const analyzedEvents = events.map((event, index) => {
      const reasons = [];
      const signals = [];
      let strongSignals = 0;
      let probability = Math.min(25, num(event.risk_score) * 0.25);

      const localDense = localGap[index] <= 3;
      const noUsername = !String(event.username || '').trim();
      const noActivity = !event.last_activity_time;
      const normalized = normalizeName(event.display_name);
      const duplicateNameCount = normalized
        ? (exactNameCounts.get(normalized) || 0)
        : 0;

      const nearestId = nearestIdDistance.get(event.id);
      let identityEvidence = false;

      if (machineBurst) {
        probability += 20;
        strongSignals += 1;
        signals.push('cohort_machine_burst');
        reasons.push(
          `Машинно-плотная волна: медианный интервал ${medianGap.toFixed(1)} сек`,
        );
      }

      if (veryDenseBurst) {
        probability += 12;
        signals.push('cohort_very_dense');
        reasons.push(
          `${Math.round(denseShare * 100)}% участников вошли почти одновременно`,
        );
      }

      if (anomalousFlow) {
        probability += 10;
        signals.push('cohort_anomaly');
        reasons.push(
          anomalyRatio >= 4
            ? `Поток выше нормы примерно в ${anomalyRatio.toFixed(1)} раза`
            : `Скорость около ${ratePerMinute.toFixed(1)} вступлений в минуту`,
        );
      }

      if (count >= 30) {
        probability += 5;
        signals.push('cohort_mass');
        reasons.push(`Массовая волна: ${count} вступлений`);
      }

      if (localDense) {
        probability += 18;
        strongSignals += 1;
        signals.push('member_dense_position');
        reasons.push(
          `Соседнее вступление произошло через ${localGap[index].toFixed(1)} сек`,
        );
      }

      if (profileHomogeneous) {
        probability += 18;
        strongSignals += 1;
        signals.push('cohort_profile_homogeneity');
        reasons.push(
          `У ${Math.round(noUsernameShare * 100)}% волны нет username и ` +
          `у ${Math.round(noActivityShare * 100)}% не видна активность`,
        );
      }

      if (noUsername) {
        probability += 6;
        signals.push('member_no_username');
        reasons.push('Нет публичного username — слабый индивидуальный признак');
      }

      if (noActivity) {
        probability += 6;
        signals.push('member_no_activity');
        reasons.push(
          'MAX не передал активность — слабый индивидуальный признак',
        );
      }

      const snapshot = json(event.profile_snapshot, {});
      const signature = [
        event.username ? 'u1' : 'u0',
        event.last_activity_time ? 'a1' : 'a0',
        snapshot?.description ? 'd1' : 'd0',
        nameShape(event.display_name),
      ].join('|');

      if (
        dominantSignatureShare >= 0.65 &&
        (signatureCounts.get(signature) || 0) === dominantSignatureCount
      ) {
        probability += 7;
        signals.push('dominant_profile_signature');
        reasons.push(
          `Профиль совпадает с доминирующим шаблоном ` +
          `${Math.round(dominantSignatureShare * 100)}% волны`,
        );
      }

      if (dominantShapeShare >= 0.80) {
        probability += 5;
        signals.push('dominant_name_structure');
        reasons.push(
          `Структура имени совпадает у ${Math.round(dominantShapeShare * 100)}% волны`,
        );
      }

      if (nearestId !== null && nearestId !== undefined) {
        if (nearestId <= 20n) {
          probability += 25;
          strongSignals += 1;
          identityEvidence = true;
          signals.push('near_sequential_max_id');
          reasons.push(
            `MAX ID находится в почти последовательной группе: расстояние ${nearestId}`,
          );
        } else if (nearestId <= 500n) {
          probability += 15;
          strongSignals += 1;
          identityEvidence = true;
          signals.push('tight_max_id_cluster');
          reasons.push(
            `MAX ID находится в плотном кластере: расстояние ${nearestId}`,
          );
        } else if (nearestId <= 5000n) {
          probability += 8;
          signals.push('wide_max_id_cluster');
          reasons.push(
            `MAX ID находится рядом с другим участником волны: расстояние ${nearestId}`,
          );
        }
      }

      if (duplicateNameCount >= 3) {
        probability += 22;
        strongSignals += 1;
        identityEvidence = true;
        signals.push('duplicate_identity_template');
        reasons.push(
          `Одинаковое имя встречается у ${duplicateNameCount} участников`,
        );
      } else if (duplicateNameCount === 2) {
        probability += 10;
        signals.push('duplicate_name');
        reasons.push('Имя повторяется внутри волны');
      }

      if (event.is_bot) {
        probability += 30;
        strongSignals += 1;
        identityEvidence = true;
        signals.push('official_max_bot');
        reasons.push('MAX помечает профиль как официальный бот-аккаунт');
      }

      probability = clamp(Math.round(probability), 0, 100);

      const whitelisted = whitelist.has(String(event.user_id));
      const protectedMember = Boolean(event.is_admin || event.is_owner || whitelisted);
      const profileEvidence = Boolean(
        profileHomogeneous &&
        noUsername &&
        noActivity
      );

      const eligible = Boolean(
        !protectedMember &&
        count >= 15 &&
        probability >= 92 &&
        confidence >= 0.78 &&
        machineBurst &&
        localDense &&
        strongSignals >= 3 &&
        (profileEvidence || identityEvidence)
      );

      let botClass = 'likely_human';

      if (protectedMember) {
        probability = 0;
        botClass = 'likely_human';
        reasons.length = 0;
        reasons.push(
          whitelisted
            ? 'Пользователь находится в белом списке'
            : 'Администратор или владелец канала',
        );
        signals.length = 0;
        strongSignals = 0;
      } else if (event.is_bot) {
        botClass = 'official_max_bot';
      } else if (eligible || (probability >= 94 && confidence >= 0.80)) {
        botClass = 'high_confidence_bot';
      } else if (probability >= 80 && confidence >= 0.65) {
        botClass = 'likely_bot';
      } else if (probability >= 55) {
        botClass = 'suspicious';
      }

      return {
        id: event.id,
        userId: String(event.user_id),
        probability,
        botClass,
        reasons: uniq(reasons),
        signals: uniq(signals),
        strongSignals,
        eligible,
      };
    });

    const summary = {
      version: 2,
      count,
      duration_seconds: Math.round(durationSeconds),
      rate_per_minute: Number(ratePerMinute.toFixed(2)),
      median_gap_seconds: Number(medianGap.toFixed(2)),
      p80_gap_seconds: Number(p80Gap.toFixed(2)),
      p90_gap_seconds: Number(p90Gap.toFixed(2)),
      cadence_cv: Number(cadenceCv.toFixed(3)),
      dense_share: Number(denseShare.toFixed(3)),
      no_username_share: Number(noUsernameShare.toFixed(3)),
      no_activity_share: Number(noActivityShare.toFixed(3)),
      dominant_signature_share: Number(dominantSignatureShare.toFixed(3)),
      dominant_name_shape_share: Number(dominantShapeShare.toFixed(3)),
      anomaly_ratio: Number(anomalyRatio.toFixed(2)),
      machine_burst: machineBurst,
      very_dense_burst: veryDenseBurst,
      anomalous_flow: anomalousFlow,
      profile_homogeneous: profileHomogeneous,
      regular_cadence: regularCadence,
      confidence: Number(confidence.toFixed(3)),
      avatars_used_for_scoring: false,
    };

    return {
      confidence,
      summary,
      events: analyzedEvents,
    };
  }

  async function rescoreWave(waveId, { enrich = true } = {}) {
    await ensureSchema();

    const safeWaveId = num(waveId);
    if (!safeWaveId) return null;

    if (runningWaves.has(safeWaveId)) {
      return waveById(safeWaveId);
    }

    runningWaves.add(safeWaveId);

    try {
      let wave = await waveById(safeWaveId);
      if (!wave || wave.status === 'ignored') return wave;

      let events = await fetchWaveEvents(safeWaveId);
      if (!events.length) return wave;

      if (enrich) {
        await enrichWaveMembers(wave, events);
        events = await fetchWaveEvents(safeWaveId);
      }

      const whitelistRows = rows(await query(
        `SELECT user_id
         FROM public.lr_antifraud_whitelist
         WHERE channel_id=$1`,
        [wave.channel_id],
      ));

      const whitelist = new Set(
        whitelistRows.map((row) => String(row.user_id)),
      );

      const analysis = analyzeWave(events, wave, whitelist);

      for (const item of analysis.events) {
        await query(
          `UPDATE public.lr_antifraud_events
           SET
             bot_probability=$2,
             bot_class=$3,
             cohort_signals=$4::jsonb,
             cohort_strong_signals=$5,
             risk_score=$2,
             risk_reasons=$6::jsonb,
             strong_signals=$5,
             removal_eligible=$7,
             updated_at=now()
           WHERE id=$1`,
          [
            item.id,
            item.probability,
            item.botClass,
            JSON.stringify(item.signals),
            item.strongSignals,
            JSON.stringify(item.reasons),
            item.eligible,
          ],
        );
      }

      const counts = analysis.events.reduce(
        (result, item) => {
          if (item.probability >= 85) result.high += 1;
          else if (item.probability >= 55) result.medium += 1;
          else result.normal += 1;

          if (
            item.botClass === 'official_max_bot' ||
            item.botClass === 'high_confidence_bot' ||
            item.botClass === 'likely_bot'
          ) {
            result.probable += 1;
          }

          if (
            item.botClass === 'official_max_bot' ||
            item.botClass === 'high_confidence_bot'
          ) {
            result.highConfidence += 1;
          }

          if (
            item.botClass === 'suspicious' ||
            (item.botClass === 'likely_bot' && !item.eligible)
          ) {
            result.review += 1;
          }

          if (item.botClass === 'official_max_bot') result.official += 1;
          if (item.eligible) result.eligible += 1;

          return result;
        },
        {
          high: 0,
          medium: 0,
          normal: 0,
          probable: 0,
          highConfidence: 0,
          review: 0,
          official: 0,
          eligible: 0,
        },
      );

      wave = rows(await query(
        `UPDATE public.lr_antifraud_waves
         SET
           high_count=$2,
           medium_count=$3,
           normal_count=$4,
           max_bot_count=$5,
           eligible_count=$6,
           probable_bot_count=$7,
           high_confidence_bot_count=$8,
           review_count=$9,
           official_bot_count=$5,
           cohort_confidence=$10,
           cohort_summary=$11::jsonb,
           updated_at=now()
         WHERE id=$1
         RETURNING *`,
        [
          safeWaveId,
          counts.high,
          counts.medium,
          counts.normal,
          counts.official,
          counts.eligible,
          counts.probable,
          counts.highConfidence,
          counts.review,
          analysis.confidence,
          JSON.stringify(analysis.summary),
        ],
      ))[0] || wave;

      if (typeof refreshWave === 'function') {
        wave = (await refreshWave(safeWaveId)) || wave;
      }

      if (typeof onWaveScored === 'function') {
        await onWaveScored(wave);
      }

      log(
        `wave ${safeWaveId}: confidence=${analysis.confidence.toFixed(2)}, ` +
        `probable=${counts.probable}, eligible=${counts.eligible}`,
      );

      return wave;
    } finally {
      runningWaves.delete(safeWaveId);
    }
  }

  async function rescoreRecent({
    hours = 24,
    limit = 100,
    enrich = false,
  } = {}) {
    await ensureSchema();

    const waves = rows(await query(
      `SELECT id
       FROM public.lr_antifraud_waves
       WHERE status<>'ignored'
         AND started_at>=now()-($1::text || ' hours')::interval
       ORDER BY started_at DESC
       LIMIT $2`,
      [String(Math.max(1, num(hours, 24))), Math.max(1, num(limit, 100))],
    ));

    for (const wave of waves) {
      try {
        await rescoreWave(wave.id, { enrich });
      } catch (rescoreError) {
        error(
          `wave ${wave.id} rescore failed:`,
          rescoreError?.stack || rescoreError?.message || rescoreError,
        );
      }
    }

    return waves.length;
  }

  async function checkRemovalCapability(maxChatId) {
    try {
      const member = await maxFetch(
        `/chats/${encodeURIComponent(String(maxChatId))}/members/me`,
      );

      const source = member?.member || member?.user || member || {};
      const permissions = Array.isArray(source.permissions)
        ? source.permissions.map(String)
        : [];

      return {
        known: true,
        isAdmin: Boolean(source.is_admin ?? source.isAdmin),
        isOwner: Boolean(source.is_owner ?? source.isOwner),
        permissions,
        hasPermission: permissions.includes('add_remove_members'),
      };
    } catch (capabilityError) {
      return {
        known: false,
        isAdmin: false,
        isOwner: false,
        permissions: [],
        hasPermission: false,
        error: String(capabilityError?.message || capabilityError),
      };
    }
  }

  async function start() {
    await ensureSchema();

    setTimeout(() => {
      rescoreRecent({
        hours: 24,
        limit: 100,
        enrich: true,
      }).catch((startupError) => {
        error(
          'startup rescore failed:',
          startupError?.stack || startupError?.message || startupError,
        );
      });
    }, 6_000).unref?.();

    if (!timer) {
      timer = setInterval(() => {
        timerTick += 1;

        rescoreRecent({
          hours: 1,
          limit: 25,
          enrich: timerTick % 10 === 0,
        }).catch((timerError) => {
          error(
            'active-wave rescore failed:',
            timerError?.stack || timerError?.message || timerError,
          );
        });
      }, 30_000);

      timer.unref?.();
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    version: '2.0.0',
    ensureSchema,
    rescoreWave,
    rescoreRecent,
    checkRemovalCapability,
    start,
    stop,
  };
}


// PP's健康簿 服务端：提供页面、保存家庭数据、接收 iPhone 自动推送的 Apple Watch 数据。
// 只用 Node 内置模块，部署时无需 npm install。数据存在 data/state.json（单文件，便于备份和迁移）。
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';      // iPhone 推送用的口令
const PAGE_PASSWORD = process.env.PAGE_PASSWORD || '';    // 打开网页的家庭密码（Basic 认证）
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_BODY = 60 * 1024 * 1024;

/* ---------- 存储 ---------- */
function emptyState() {
  return {
    version: 2,
    members: [
      { id: 'me', name: '我', account: 'primary', status: 'active' },
      { id: 'mom', name: '妈妈', account: 'sub', status: 'active' },
      { id: 'dad', name: '爸爸', account: 'sub', status: 'active' }
    ],
    daily: [], segments: [], clinical: [], symptoms: [], records: [], plans: [], reports: [], meds: [], cycles: [], checkins: [], goals: [], routines: [], products: [], foods: [],
    sources: {}, reminders: { daily: true, weekly: true, monthly: true, quarterly: true, yearly: true, plan: true, trend: true },
    appleSync: {}, unknownMetrics: {}, shares: []
  };
}
function load() {
  try { return Object.assign(emptyState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch (e) { if (e.code !== 'ENOENT') console.error('读取 state.json 失败', e); return emptyState(); }
}
/* 备份（只存在服务器上）：每次整表保存前留一份旧版本（保留 30 份），另外每周留一份（保留 12 周） */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function backupState(tag) {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(path.join(BACKUP_DIR, 'state-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + tag + '.json.gz'), require('node:zlib').gzipSync(fs.readFileSync(STATE_FILE)));
    for (const [t, keep] of [['sync', 30], ['checkin', 30], ['weekly', 12]]) {
      const list = fs.readdirSync(BACKUP_DIR).filter(n => n.endsWith('-' + t + '.json.gz')).sort();
      list.slice(0, Math.max(0, list.length - keep)).forEach(n => fs.unlinkSync(path.join(BACKUP_DIR, n)));
    }
  } catch (e) { console.error('备份失败', e); }
}
function backupInfo() {
  try { const list = fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith('state-')).sort(); const last = list[list.length - 1];
    return last ? { count: list.length, last: fs.statSync(path.join(BACKUP_DIR, last)).mtime.toISOString() } : null; } catch (e) { return null; }
}
function weeklyBackup() {
  try { const w = (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR) : []).filter(n => n.endsWith('-weekly.json.gz')).sort().pop();
    if (!w || Date.now() - fs.statSync(path.join(BACKUP_DIR, w)).mtimeMs > 7 * 864e5) backupState('weekly'); } catch (e) { console.error('每周备份失败', e); }
}
function persist(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}
let state = load();

/* ---------- Apple Watch 数据（Health Auto Export 的 JSON） ---------- */
const num = v => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null);
const dayOf = s => (typeof s === 'string' ? s.slice(0, 10) : null);
const qty = v => (v && typeof v === 'object' ? num(v.qty) : num(v));
// 字段 → [日快照字段, 合并方式, 换算]
const METRIC_MAP = {
  weight_body_mass:                 ['weight', 'last', (v, u) => (/lb/i.test(u) ? v * 0.45359237 : v)],
  body_fat_percentage:              ['body_fat', 'last', v => (v <= 1 ? v * 100 : v)],
  resting_heart_rate:               ['resting_hr', 'avg'],
  walking_heart_rate_average:       ['walking_hr', 'avg'],
  heart_rate_variability:           ['hrv', 'avg'],
  heart_rate_variability_sdnn:      ['hrv', 'avg'],
  step_count:                       ['steps', 'sum'],
  active_energy:                    ['active_energy', 'sum', (v, u) => (/kj/i.test(u) ? v / 4.184 : v)],
  vo2_max:                          ['vo2max', 'last'],
  respiratory_rate:                 ['resp_rate', 'avg'],
  blood_oxygen_saturation:          ['spo2', 'avg', v => (v <= 1 ? v * 100 : v)],
  apple_sleeping_wrist_temperature: ['wrist_temp', 'avg'],
  apple_exercise_time:              ['exercise_minutes', 'sum']
};
const ROUND = { sleep_total: 0, sleep_deep: 0, sleep_rem: 0, workout_minutes: 0, workout_count: 0, weight: 1, body_fat: 1, resting_hr: 0, walking_hr: 0, hrv: 0, steps: 0, active_energy: 0, vo2max: 1, resp_rate: 1, spo2: 0, wrist_temp: 2, exercise_minutes: 0 };
const WORKOUT_CN = [[/run/i, '跑步'], [/walk/i, '步行'], [/cycl|bike/i, '骑行'], [/swim/i, '游泳'], [/strength|weight/i, '力量训练'], [/hiit|interval/i, 'HIIT'], [/yoga/i, '瑜伽'], [/hik/i, '徒步'], [/ellip/i, '椭圆机'], [/row/i, '划船'], [/core/i, '核心训练'], [/pilates/i, '普拉提'], [/badminton/i, '羽毛球'], [/basketball/i, '篮球'], [/tennis/i, '网球']];

function ingestAppleHealth(memberId, body) {
  const data = body && body.data ? body.data : body;
  const metrics = Array.isArray(data && data.metrics) ? data.metrics : [];
  const workouts = Array.isArray(data && data.workouts) ? data.workouts : [];
  const days = {};   // date -> { field: value }
  const bucket = {}; // date|field -> { mode, vals: [] }
  const sleepNights = {};
  let points = 0;

  for (const m of metrics) {
    const name = String(m.name || '').toLowerCase(), units = String(m.units || '');
    const rows = Array.isArray(m.data) ? m.data : [];
    if (name === 'sleep_analysis') {
      for (const r of rows) {
        const d = dayOf(r.sleepEnd) || dayOf(r.date); if (!d) continue;
        const h = k => num(r[k]);
        const core = h('core'), deep = h('deep'), rem = h('rem'), awake = h('awake');
        const total = h('totalSleep') ?? h('asleep') ?? ((core ?? 0) + (deep ?? 0) + (rem ?? 0) || null);
        if (total == null) continue;
        const toMin = v => (v == null ? null : Math.round(/min/i.test(units) ? v : v * 60));
        const n = { total: toMin(total), deep: toMin(deep), rem: toMin(rem), core: toMin(core), awake: toMin(awake), start: r.sleepStart || null, end: r.sleepEnd || null };
        if (!sleepNights[d] || n.total > sleepNights[d].total) sleepNights[d] = n; // 同一晚多个来源时取最长的一份
        points++;
      }
      continue;
    }
    const map = METRIC_MAP[name];
    if (!map) { state.unknownMetrics[name] = (state.unknownMetrics[name] || 0) + rows.length; continue; }
    const [field, mode, conv] = map;
    for (const r of rows) {
      const d = dayOf(r.date); let v = num(r.qty) ?? num(r.Avg) ?? num(r.avg);
      if (!d || v == null) continue;
      if (conv) v = conv(v, units);
      const k = d + '|' + field;
      (bucket[k] = bucket[k] || { mode, vals: [] }).vals.push({ v, t: String(r.date) });
      points++;
    }
  }
  for (const [k, b] of Object.entries(bucket)) {
    const [d, field] = k.split('|');
    let v;
    if (b.mode === 'sum') v = b.vals.reduce((s, x) => s + x.v, 0);
    else if (b.mode === 'avg') v = b.vals.reduce((s, x) => s + x.v, 0) / b.vals.length;
    else v = b.vals.sort((a, c) => (a.t < c.t ? -1 : 1))[b.vals.length - 1].v;
    const p = 10 ** (ROUND[field] ?? 1);
    (days[d] = days[d] || {})[field] = Math.round(v * p) / p;
  }
  for (const [d, n] of Object.entries(sleepNights)) {
    Object.assign(days[d] = days[d] || {}, { sleep_total: n.total, sleep_deep: n.deep, sleep_rem: n.rem });
    const id = 'sleep_' + memberId + '_' + d;
    state.segments = state.segments.filter(s => s.id !== id);
    state.segments.push({ id, member_id: memberId, kind: 'sleep', type: '睡眠', start: d, duration_min: n.total, deep: n.deep, rem: n.rem, core: n.core, awake: n.awake, sleep_start: n.start, sleep_end: n.end, source: 'Apple Watch' });
  }

  // 每次运动单独保存（分段数据），按 id 去重
  const touchedWorkoutDays = new Set();
  for (const w of workouts) {
    const start = w.start || w.startDate; if (!start) continue;
    const id = 'wk_' + memberId + '_' + (w.id || crypto.createHash('sha1').update(String(w.name) + start).digest('hex').slice(0, 12));
    const durSec = num(w.duration);
    const dur = durSec != null ? Math.round(durSec / 60) : null;
    const en = qty(w.activeEnergyBurned) ?? qty(w.activeEnergy) ?? qty(w.totalEnergy);
    const avgHr = qty(w.avgHeartRate) ?? qty(w.heartRate && w.heartRate.avg);
    const maxHr = qty(w.maxHeartRate) ?? qty(w.heartRate && w.heartRate.max);
    const type = (WORKOUT_CN.find(([re]) => re.test(w.name || '')) || [null, w.name || '运动'])[1];
    state.segments = state.segments.filter(s => s.id !== id);
    state.segments.push({ id, member_id: memberId, kind: 'workout', type, start: String(start).slice(0, 16).replace(' ', 'T'), duration_min: dur,
      avg_hr: avgHr != null ? Math.round(avgHr) : null, max_hr: maxHr != null ? Math.round(maxHr) : null, energy: en != null ? Math.round(en) : null, recovery_hr: null, source: 'Apple Watch' });
    touchedWorkoutDays.add(dayOf(String(start)));
    points++;
  }
  for (const d of touchedWorkoutDays) {
    const ws = state.segments.filter(s => s.member_id === memberId && s.kind === 'workout' && s.start.slice(0, 10) === d);
    Object.assign(days[d] = days[d] || {}, { workout_minutes: ws.reduce((s, x) => s + (x.duration_min || 0), 0), workout_count: ws.length });
  }

  // 合并进每日快照：这次推送带来的字段覆盖旧值，没带的字段保持原样（无数据就是 null，不写 0）
  const now = new Date().toISOString();
  for (const [d, fields] of Object.entries(days)) {
    let row = state.daily.find(x => x.member_id === memberId && x.date === d);
    if (!row) { row = { date: d, member_id: memberId, source: 'Apple Health', body_fat_method: 'BIA' }; state.daily.push(row); }
    Object.assign(row, fields, { snapshot_generated_at: now, real: true });
  }
  state.daily.sort((a, b) => (a.date < b.date ? -1 : 1));
  const memberDays = state.daily.filter(x => x.member_id === memberId).length;
  state.appleSync[memberId] = { last: now, days: memberDays, lastPoints: points };
  state.sources[memberId] = Object.assign({ manual: true, reports: true }, state.sources[memberId], { apple: true });
  return { days: Object.keys(days).length, points };
}

/* ---------- Apple Watch 数据（iOS 快捷指令自动化，免费、系统自带） ----------
 * 快捷指令每天定时/打开常用 App 时，把当天和前一天的汇总 POST 到 /api/ingest/shortcut?member=me。
 * 一次一天或多天：{ "date": "2026-10-25", "steps": 8123, ... } 或 { "days": [ {...}, {...} ] }。
 * 数字可以带单位文字（快捷指令有时会输出“8123 步”），这里统一取数字；缺的字段保持原值，不写 0。 */
const SHORTCUT_FIELDS = { weight: 'weight', body_fat: 'body_fat', sleep_total: 'sleep_total', sleep_deep: 'sleep_deep', sleep_rem: 'sleep_rem', resting_hr: 'resting_hr',
  walking_hr: 'walking_hr', hrv: 'hrv', steps: 'steps', active_energy: 'active_energy', exercise_minutes: 'exercise_minutes', workout_minutes: 'workout_minutes',
  workout_count: 'workout_count', vo2max: 'vo2max', resp_rate: 'resp_rate', spo2: 'spo2', wrist_temp: 'wrist_temp' };
const looseNum = v => { if (typeof v === 'number') return isFinite(v) ? v : null; const m = /-?\d+(?:[.,]\d+)?/.exec(String(v == null ? '' : v).replace(/,(?=\d{3}\b)/g, '')); return m ? +m[0].replace(',', '.') : null; };
function ingestShortcut(member, body) {
  const list = Array.isArray(body) ? body : Array.isArray(body && body.days) ? body.days : [body];
  const now = new Date().toISOString(); let n = 0;
  for (const day of list) {
    const d = String(day && day.date || '').slice(0, 10).replace(/\//g, '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const fields = {};
    for (const [k, f] of Object.entries(SHORTCUT_FIELDS)) {
      let v = looseNum(day[k]); if (v == null) continue;
      if ((f === 'body_fat' || f === 'spo2') && v <= 1) v *= 100;           // 0.21 → 21%
      if (f.startsWith('sleep_') && day.sleep_unit === 'hr') v *= 60;       // 小时 → 分钟
      const p = 10 ** (ROUND[f] ?? 0); fields[f] = Math.round(v * p) / p;
    }
    if (!Object.keys(fields).length) continue;
    let row = state.daily.find(x => x.member_id === member && x.date === d);
    if (!row) { row = { date: d, member_id: member, source: 'Apple Health', body_fat_method: 'BIA' }; state.daily.push(row); }
    Object.assign(row, fields, { snapshot_generated_at: now, real: true }); n++;
  }
  state.daily.sort((a, b) => (a.date < b.date ? -1 : 1));
  state.appleSync[member] = { last: now, days: state.daily.filter(x => x.member_id === member).length, via: '快捷指令' };
  state.sources[member] = Object.assign({ manual: true, reports: true }, state.sources[member], { apple: true });
  return { days: n };
}

/* ---------- Apple Watch 数据（Pulso 开源数据桥，协议 v1） ----------
 * iPhone 上的 Pulso 把 HealthKit 原始样本推到 /pulso/<成员>/ingest。
 * 原始样本按 uuid 去重后原样存进 data/raw/<成员>/<type>.ndjson（可导出、可迁移），
 * 再按天重算每日快照和运动/睡眠分段。 */
const zlib = require('node:zlib');
const RAW_DIR = path.join(DATA_DIR, 'raw');
// 需要进内存参与汇总的类型；其他类型只存原始文件
const AGG_TYPES = new Set(['bodyMass', 'bodyFatPercentage', 'restingHeartRate', 'walkingHeartRateAverage', 'heartRateVariabilitySDNN', 'stepCount', 'activeEnergyBurned',
  'vo2Max', 'respiratoryRate', 'oxygenSaturation', 'appleSleepingWristTemperature', 'appleExerciseTime', 'sleepAnalysis', 'workout']);
const PULSO_FIELDS = {
  bodyMass: ['weight', 'last'], bodyFatPercentage: ['body_fat', 'last'], restingHeartRate: ['resting_hr', 'avg'], walkingHeartRateAverage: ['walking_hr', 'avg'],
  heartRateVariabilitySDNN: ['hrv', 'avg'], stepCount: ['steps', 'sum'], activeEnergyBurned: ['active_energy', 'sum'], vo2Max: ['vo2max', 'last'],
  respiratoryRate: ['resp_rate', 'avg'], oxygenSaturation: ['spo2', 'avg'], appleSleepingWristTemperature: ['wrist_temp', 'avg'], appleExerciseTime: ['exercise_minutes', 'sum']
};
const pulso = {}; // member -> { uuids:Set, deleted:Set, byDay: Map(day -> Map(uuid -> sample)), latest: {type: [ms, iso]} }

const instant = s => { const t = Date.parse(s); return isNaN(t) ? null : t; };
// 样本自带时区下的日期；sleep 的“哪一晚”按醒来时间 +6 小时归日，23:50 入睡算第二天
const LOCAL_TZ_MIN = (+process.env.TZ_OFFSET_HOURS || 8) * 60;
function localDay(s, addHours) {
  const m = /([+-])(\d{2}):?(\d{2})$|Z$/.exec(s || ''); const t = instant(s); if (t == null) return null;
  const off = m && m[1] ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : LOCAL_TZ_MIN;
  return new Date(t + off * 60000 + (addHours || 0) * 3600000).toISOString().slice(0, 10);
}
const dayKey = x => (x.type === 'sleepAnalysis' ? localDay(x.end, 6) : localDay(x.start));
function memberStore(member) {
  if (pulso[member]) return pulso[member];
  const st = pulso[member] = { uuids: new Set(), deleted: new Set(), byDay: new Map(), latest: {} };
  const dir = path.join(RAW_DIR, member);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.ndjson')); } catch (e) { return st; }
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let x; try { x = JSON.parse(line); } catch (e) { continue; }
      if (f === '_deleted.ndjson') { (x.deleted || []).forEach(u => st.deleted.add(u)); continue; }
      remember(st, x);
    }
  }
  return st;
}
function remember(st, x) {
  st.uuids.add(x.uuid);
  const e = instant(x.end);
  if (e != null && (!st.latest[x.type] || e > st.latest[x.type][0])) st.latest[x.type] = [e, x.end];
  if (!AGG_TYPES.has(x.type)) return null;
  const d = dayKey(x); if (!d) return null;
  if (!st.byDay.has(d)) st.byDay.set(d, new Map());
  const prev = st.byDay.get(d).get(x.uuid);
  if (prev && x._replace) for (const k of Object.keys(prev)) if (x[k] == null) x[k] = prev[k];
  st.byDay.get(d).set(x.uuid, { uuid: x.uuid, type: x.type, start: x.start, end: x.end, value: x.value, source: x.source || '', workoutActivityType: x.workoutActivityType,
    duration: x.duration, totalEnergyBurned: x.totalEnergyBurned, averageHeartRate: x.averageHeartRate, maximumHeartRate: x.maximumHeartRate, totalDistance: x.totalDistance });
  return d;
}
const WORKOUT_PULSO_CN = { running: '跑步', walking: '步行', cycling: '骑行', swimming: '游泳', traditionalStrengthTraining: '力量训练', functionalStrengthTraining: '功能性力量',
  highIntensityIntervalTraining: 'HIIT', yoga: '瑜伽', hiking: '徒步', elliptical: '椭圆机', rowing: '划船', coreTraining: '核心训练', pilates: '普拉提', badminton: '羽毛球',
  basketball: '篮球', tennis: '网球', tableTennis: '乒乓球', soccer: '足球', dance: '舞蹈', cooldown: '放松', mixedCardio: '混合有氧', stairClimbing: '爬楼' };
// 重算某成员某天的快照与分段
function rebuildDay(member, d) {
  const st = memberStore(member);
  const all = [...(st.byDay.get(d) || new Map()).values()].filter(x => !st.deleted.has(x.uuid));
  const row = { date: d, member_id: member, source: 'Apple Health', body_fat_method: 'BIA', real: true, snapshot_generated_at: new Date().toISOString() };
  for (const [type, [field, mode]] of Object.entries(PULSO_FIELDS)) {
    const xs = all.filter(x => x.type === type && typeof x.value === 'number');
    if (!xs.length) { row[field] = null; continue; }
    let v;
    if (mode === 'last') v = xs.sort((a, b) => instant(a.start) - instant(b.start))[xs.length - 1].value;
    else if (mode === 'avg') v = xs.reduce((s, x) => s + x.value, 0) / xs.length;
    else { // iPhone 和手表会各记一份，按来源分别求和后取最大，避免重复计算
      const by = {}; xs.forEach(x => { by[x.source] = (by[x.source] || 0) + x.value; }); v = Math.max(...Object.values(by));
    }
    const p = 10 ** (ROUND[field] ?? 1); row[field] = Math.round(v * p) / p;
  }
  // 睡眠：同一晚多个来源时取睡得最长的那份
  const sl = all.filter(x => x.type === 'sleepAnalysis'), bySrc = {};
  sl.forEach(x => {
    const m = (instant(x.end) - instant(x.start)) / 60000; if (!(m > 0)) return;
    const s = bySrc[x.source] = bySrc[x.source] || { core: 0, deep: 0, rem: 0, unspec: 0, awake: 0, first: x.start, last: x.end };
    const k = { asleepCore: 'core', asleepDeep: 'deep', asleepREM: 'rem', asleepUnspecified: 'unspec', asleep: 'unspec', awake: 'awake' }[x.value];
    if (k) s[k] += m;
    if (instant(x.start) < instant(s.first)) s.first = x.start; if (instant(x.end) > instant(s.last)) s.last = x.end;
  });
  const best = Object.values(bySrc).map(s => Object.assign(s, { total: s.core + s.deep + s.rem + s.unspec })).sort((a, b) => b.total - a.total)[0];
  const sid = 'sleep_' + member + '_' + d;
  state.segments = state.segments.filter(s => s.id !== sid);
  if (best && best.total > 0) {
    Object.assign(row, { sleep_total: Math.round(best.total), sleep_deep: Math.round(best.deep) || null, sleep_rem: Math.round(best.rem) || null });
    state.segments.push({ id: sid, member_id: member, kind: 'sleep', type: '睡眠', start: d, duration_min: Math.round(best.total), deep: Math.round(best.deep), rem: Math.round(best.rem),
      core: Math.round(best.core), awake: Math.round(best.awake), sleep_start: best.first, sleep_end: best.last, source: 'Apple Watch' });
  } else Object.assign(row, { sleep_total: null, sleep_deep: null, sleep_rem: null });
  // 运动：每次单独保存
  state.segments = state.segments.filter(s => !(s.member_id === member && s.kind === 'workout' && s.day === d));
  const ws = all.filter(x => x.type === 'workout');
  ws.forEach(w => state.segments.push({ id: 'wk_' + w.uuid, member_id: member, kind: 'workout', day: d, type: WORKOUT_PULSO_CN[w.workoutActivityType] || (WORKOUT_CN.find(([re]) => re.test(w.workoutActivityType || '')) || [null, w.workoutActivityType || '运动'])[1],
    start: String(w.start).slice(0, 16), duration_min: num(w.duration) != null ? Math.round(w.duration / 60) : null, avg_hr: num(w.averageHeartRate) != null ? Math.round(w.averageHeartRate) : null,
    max_hr: num(w.maximumHeartRate) != null ? Math.round(w.maximumHeartRate) : null, energy: num(w.totalEnergyBurned) != null ? Math.round(w.totalEnergyBurned) : null,
    distance_m: num(w.totalDistance), recovery_hr: null, source: w.source || 'Apple Watch' }));
  row.workout_minutes = ws.length ? ws.reduce((s, w) => s + (num(w.duration) || 0), 0) / 60 | 0 : null;
  row.workout_count = ws.length || null;
  const has = Object.keys(row).some(k => !['date', 'member_id', 'source', 'body_fat_method', 'real', 'snapshot_generated_at'].includes(k) && row[k] != null);
  state.daily = state.daily.filter(x => !(x.member_id === member && x.date === d));
  if (has) state.daily.push(row);
}
function ingestPulso(member, items) {
  const st = memberStore(member), dir = path.join(RAW_DIR, member);
  fs.mkdirSync(dir, { recursive: true });
  const lines = {}, days = new Set(), stamp = new Date().toISOString();
  let fresh = 0, del = 0;
  for (const it of items) {
    if (it && Array.isArray(it.deleted)) {
      (lines._deleted = lines._deleted || []).push(JSON.stringify({ deleted: it.deleted, receivedAt: stamp }));
      it.deleted.forEach(u => { if (!st.deleted.has(u)) { st.deleted.add(u); del++; } for (const [d, m] of st.byDay) if (m.has(u)) days.add(d); });
      continue;
    }
    if (!it || typeof it.uuid !== 'string' || typeof it.type !== 'string') continue;
    if (st.uuids.has(it.uuid) && !it._replace) continue;   // 汇总桶、补全的运动记录会带 _replace 覆盖旧值
    const type = it.type.replace(/[^A-Za-z0-9_]/g, '') || 'unknown';
    (lines[type] = lines[type] || []).push(JSON.stringify(Object.assign({}, it, { receivedAt: stamp })));
    const d = remember(st, it); if (d) days.add(d);
    fresh++;
  }
  for (const [type, ls] of Object.entries(lines)) fs.appendFileSync(path.join(dir, type + '.ndjson'), ls.join('\n') + '\n');
  for (const d of days) rebuildDay(member, d);
  state.daily.sort((a, b) => (a.date < b.date ? -1 : 1));
  state.appleSync[member] = { last: stamp, days: state.daily.filter(x => x.member_id === member).length, via: 'Pulso' };
  state.sources[member] = Object.assign({ manual: true, reports: true }, state.sources[member], { apple: true });
  return { received: items.length, new: fresh, deleted: del, days: days.size };
}
function readRaw(req) {
  return new Promise((ok, no) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks))); req.on('error', no);
  });
}

/* ---------- Apple Watch 数据（FreeReps App，App Store 免费） ----------
 * FreeReps 只连 Tailscale 内网，所以这些接口单独开一个只给 Tailscale 用的端口（FREEREPS_PORT），
 * 公网 nginx 不转发到这个端口。数据格式和 Health Auto Export 相同（逐条样本带 source_uuid），
 * 这里转换成 Pulso 的样本格式，复用同一套去重、原始存档和按天汇总。 */
const FREEREPS_PORT = +process.env.FREEREPS_PORT || 0;
const FR_MEMBER_MAP = Object.fromEntries(String(process.env.FREEREPS_MEMBERS || '').split(',').filter(Boolean).map(x => x.split('=').map(t => t.trim())));
const FR_TYPES = { weight_body_mass: 'bodyMass', body_fat_percentage: 'bodyFatPercentage', resting_heart_rate: 'restingHeartRate', walking_heart_rate_average: 'walkingHeartRateAverage',
  heart_rate_variability: 'heartRateVariabilitySDNN', step_count: 'stepCount', active_energy: 'activeEnergyBurned', vo2_max: 'vo2Max', respiratory_rate: 'respiratoryRate',
  blood_oxygen_saturation: 'oxygenSaturation', apple_sleeping_wrist_temperature: 'appleSleepingWristTemperature', apple_exercise_time: 'appleExerciseTime', heart_rate: 'heartRate' };
const FR_SLEEP = { 'In Bed': 'inBed', 'Asleep Unspecified': 'asleepUnspecified', 'Awake': 'awake', 'Asleep Core': 'asleepCore', 'Asleep Deep': 'asleepDeep', 'Asleep REM': 'asleepREM' };
const haeIso = s => { const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})$/.exec(String(s || '')); return m ? m[1] + 'T' + m[2] + m[3] + ':' + m[4] : String(s || ''); };
function frMember(req) {
  const login = req.headers['tailscale-user-login'] || '';
  return FR_MEMBER_MAP[login] || FR_MEMBER_MAP['*'] || 'me';
}
function ingestFreeReps(member, body) {
  const data = (body && body.data) || {};
  const items = [], res = { metrics_received: 0, metrics_inserted: 0, workouts_received: 0, workouts_inserted: 0, sleep_stages_inserted: 0, category_samples_inserted: 0 };
  const latest = (state.frLatest = state.frLatest || {})[member] = (state.frLatest[member] || {});
  const mark = (k, iso) => { const t = instant(iso); if (t != null && (!latest[k] || t > instant(latest[k]))) latest[k] = iso; };
  for (const m of data.metrics || []) {
    const name = String(m.name || ''), units = String(m.units || ''), type = FR_TYPES[name] || name;
    for (const p of m.data || []) {
      res.metrics_received++;
      let v = num(p.qty) ?? num(p.Avg);
      if (v == null) continue;
      if ((type === 'bodyFatPercentage' || type === 'oxygenSaturation') && v <= 1) v *= 100;
      if (type === 'activeEnergyBurned' && /kj/i.test(units)) v /= 4.184;
      const iso = haeIso(p.date), src = p.source_name || p.source_bundle || '';
      items.push({ uuid: p.source_uuid || ('b:' + name + ':' + iso + ':' + src), _replace: !p.source_uuid, type, start: iso, end: iso, value: v, unit: units, source: src,
        min: num(p.Min) ?? undefined, max: num(p.Max) ?? undefined });
      mark('metrics|' + name, iso);
    }
  }
  for (const c of data.category_samples || []) {
    const sleep = /SleepAnalysis/i.test(c.type || '');
    items.push({ uuid: c.id, type: sleep ? 'sleepAnalysis' : String(c.type || 'category').replace(/^HKCategoryTypeIdentifier/, ''), start: haeIso(c.start_date), end: haeIso(c.end_date),
      value: sleep ? (FR_SLEEP[c.value_label] || 'value_' + c.value) : (c.value_label || c.value), source: c.source || '' });
    if (sleep) res.sleep_stages_inserted++; else res.category_samples_inserted++;
    mark('category_samples|', haeIso(c.end_date));
  }
  for (const w of data.workouts || []) {
    res.workouts_received++;
    const hr = w.heartRate || {};
    items.push({ uuid: w.id, _replace: true, type: 'workout', start: haeIso(w.start), end: haeIso(w.end), workoutActivityType: w.name, duration: num(w.duration),
      totalEnergyBurned: qty(w.activeEnergyBurned) ?? undefined, totalDistance: qty(w.distance) ?? undefined, averageHeartRate: qty(hr.avg) ?? undefined,
      maximumHeartRate: qty(hr.max) ?? undefined, heartRateData: w.heartRateData, route: w.route, source: w.source_name || '' });
    res.workouts_inserted++;
    mark('workouts|', haeIso(w.end));
  }
  // 其余类别（心电图、听力图、活动圆环、用药、心情等）原样存档
  const dir = path.join(RAW_DIR, member); fs.mkdirSync(dir, { recursive: true });
  for (const k of ['ecg_recordings', 'audiograms', 'activity_summaries', 'medications', 'vision_prescriptions', 'state_of_mind']) {
    const arr = data[k] || []; if (!arr.length) continue;
    fs.appendFileSync(path.join(dir, 'fr_' + k + '.ndjson'), arr.map(x => JSON.stringify(x)).join('\n') + '\n');
    res[k + '_inserted'] = arr.length;
    if (k === 'activity_summaries') arr.forEach(x => mark('activity_summaries|', String(x.date) + 'T23:59:59Z'));
  }
  const r = ingestPulso(member, items);
  state.appleSync[member].via = 'FreeReps';
  res.metrics_inserted = r.new;
  return res;
}
function freeRepsHandler(req, res) {
  const url = new URL(req.url, 'http://x');
  (async () => {
    const member = frMember(req);
    if (!state.members.some(m => m.id === member)) return send(res, 403, { error: 'unknown member' });
    const p = url.pathname.replace(/\/+$/, '');
    if (req.method === 'GET' && p === '/api/v1/version') return send(res, 200, { version: '2.2.0' });
    if (req.method === 'GET' && p === '/api/v1/me') return send(res, 200, { login: req.headers['tailscale-user-login'] || 'local', display_name: member });
    if (req.method === 'GET' && p === '/api/v1/allowlist') return send(res, 200, []);
    if (req.method === 'GET' && p === '/api/v1/sync-state') {
      const lt = (state.frLatest || {})[member] || {};
      return send(res, 200, { client: 'freereps-ios', server_now: new Date().toISOString(),
        checkpoints: Object.entries(lt).map(([k, v]) => { const [domain, item] = k.split('|'); return { domain, item: item || null, newest_sample: new Date(instant(v)).toISOString() }; }) });
    }
    if (req.method === 'POST' && p === '/api/v1/ingest') {
      const r = ingestFreeReps(member, await readBody(req));
      persist(state);
      console.log(new Date().toISOString(), 'freereps', member, r);
      return send(res, 200, r);
    }
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
    return send(res, 404, { error: 'not found' });
  })().catch(e => { console.error(e); send(res, e.code === 413 ? 413 : 400, { error: String(e.message || e) }); });
}

/* ---------- HTTP ---------- */
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}
function readBody(req) {
  return new Promise((ok, no) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { no(Object.assign(e, { code: 400 })); } });
    req.on('error', no);
  });
}
function pageAuthorized(req) {
  if (!PAGE_PASSWORD) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  return safeEq(pass, PAGE_PASSWORD);
}
const USER_TABLES = ['members', 'symptoms', 'records', 'clinical', 'plans', 'reminders', 'sources', 'meds', 'cycles', 'checkins', 'goals', 'routines', 'products', 'foods'];
/* 生活方式的几张表也会由对话整理后经 /api/checkin 写入，页面保存时按 id 合并、保留 updated 较新的那条，避免旧页面把新记录覆盖掉；撤销只改状态不删除 */
const MERGE_TABLES = ['checkins', 'goals', 'routines', 'products', 'foods', 'meds']; // meds 删除时页面发 removed: true，不直接删
function mergeById(old, incoming) {
  const by = new Map((old || []).map(x => [x.id, x]));
  for (const x of incoming) { if (!x || !x.id) continue; const o = by.get(x.id); if (!o || String(x.updated || '') >= String(o.updated || '')) by.set(x.id, x); }
  return [...by.values()];
}
const LIFE_ITEMS = { goals: 'goal', routines: 'rt', products: 'prod', foods: 'food', meds: 'supp' };
// 对话整理出的一天：{ member_id, date, text, meals, exercise, skin, feel, sleep_feel, care, notes, protein, veg, energy, advice } 外加可选的 goals / routines / products 数组
function ingestCheckin(b) {
  const mid = b.member_id || 'me', now = new Date().toISOString();
  if (!state.members.some(m => m.id === mid)) { const e = new Error('没有这个成员'); e.code = 400; throw e; }
  const out = {};
  if (b.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date)) { const e = new Error('日期格式不对'); e.code = 400; throw e; }
    const id = 'ck_' + mid + '_' + b.date, old = state.checkins.find(x => x.id === id) || {};
    const keep = ['text', 'meals', 'exercise', 'skin', 'feel', 'sleep_feel', 'care', 'notes', 'protein', 'veg', 'energy', 'advice', 'questions', 'supps', 'symptoms', 'nutrients', 'body', 'caffeine'];
    const ck = Object.assign({}, old, { id, member_id: mid, date: b.date }, Object.fromEntries(keep.filter(k => b[k] !== undefined).map(k => [k, b[k]])), { status: 'pending', updated: now, created: old.created || now });
    state.checkins = state.checkins.filter(x => x.id !== id).concat(ck);
    out.checkin = id;
  }
  for (const [t, pre] of Object.entries(LIFE_ITEMS)) if (Array.isArray(b[t])) {
    out[t] = b[t].map(x => { const o = Object.assign({ member_id: mid }, x, { id: x.id || pre + '_' + crypto.randomBytes(5).toString('hex'), updated: now }); state[t] = state[t].filter(y => y.id !== o.id).concat(o); return o.id; });
  }
  persist(state);
  return out;
}

/* ---------- health4.ai（App Store 免费）：服务器扮成它的 Supabase 后端 ---------- */
// App 里 Project URL 填本站网址，Anon key 随便填，Email 填 H4_ACCOUNTS 里的邮箱，Password 填 INGEST_TOKEN
const H4_ACCOUNTS = Object.fromEntries(String(process.env.H4_ACCOUNTS || '').split(',').filter(Boolean).map(x => x.split('=').map(t => t.trim().toLowerCase())));
const b64u = s => Buffer.from(s).toString('base64url');
function h4Sign(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), body = b64u(JSON.stringify(payload));
  return head + '.' + body + '.' + crypto.createHmac('sha256', 'h4:' + INGEST_TOKEN).update(head + '.' + body).digest('base64url');
}
function h4Verify(tok, kind) {
  const [h, b, s] = String(tok || '').split('.');
  if (!INGEST_TOKEN || !s || !safeEq(s, crypto.createHmac('sha256', 'h4:' + INGEST_TOKEN).update(h + '.' + b).digest('base64url'))) return null;
  let p; try { p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch (e) { return null; }
  return p.kind === kind && p.exp * 1000 > Date.now() && state.members.some(m => m.id === p.sub) ? p : null;
}
function h4Session(member, email) {
  const now = Math.floor(Date.now() / 1000), ttl = 7 * 86400;
  return { access_token: h4Sign({ kind: 'access', sub: member, email, exp: now + ttl }), token_type: 'bearer', expires_in: ttl,
    refresh_token: h4Sign({ kind: 'refresh', sub: member, email, exp: now + 3650 * 86400 }), user: { id: member, email } };
}
const H4_SLEEP = s => { const m = /SleepAnalysis(\w+)$/.exec(s || ''); return m ? m[1][0].toLowerCase() + m[1].slice(1) : 'unknown'; };
function ingestHealth4ai(member, body) {
  const items = [];
  for (const x of (body && body.samples) || []) {
    const id = String(x.metric_type || ''), meta = x.metadata || {};
    const type = id.replace(/^HK(Quantity|Category|Correlation)?TypeIdentifier/, '').replace(/^HKWorkoutTypeIdentifier$/, 'workout').replace(/^[A-Z]/, c => c.toLowerCase());
    const base = { uuid: 'h4:' + crypto.createHash('sha1').update([id, x.started_at, x.ended_at, x.source_device].join('|')).digest('hex').slice(0, 20),
      type, start: x.started_at, end: x.ended_at, unit: x.unit, source: x.source_device || '', metadata: Object.keys(meta).length ? meta : undefined };
    if (type === 'workout') {
      const t = String(meta.workout_type || '').replace(/^HKWorkoutActivityType/, '');
      items.push({ ...base, workoutActivityType: t ? t[0].toLowerCase() + t.slice(1) : '', duration: num(meta.duration_seconds) ?? num(x.value),
        totalEnergyBurned: num(meta.total_energy_burned_cal) ?? undefined, totalDistance: num(meta.total_distance_meters) ?? undefined });
      continue;
    }
    if (type === 'sleepAnalysis') { items.push({ ...base, value: H4_SLEEP(meta.sleep_stage) }); continue; }
    let v = num(x.value); if (v == null) continue;
    if ((type === 'bodyFatPercentage' || type === 'oxygenSaturation') && v <= 1) v *= 100;
    items.push({ ...base, value: v });
  }
  const r = ingestPulso(member, items);
  state.appleSync[member].via = 'health4.ai';
  return r;
}
async function health4aiRoute(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/auth/v1/token' && req.method === 'POST') {
    const body = await readBody(req), grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const email = String(body.email || '').trim().toLowerCase(), member = H4_ACCOUNTS[email] || H4_ACCOUNTS['*'];
      if (!INGEST_TOKEN || !member || !safeEq(String(body.password || ''), INGEST_TOKEN) || !state.members.some(m => m.id === member))
        return send(res, 400, { error: 'invalid_grant', error_description: '邮箱或密码不对' });
      return send(res, 200, h4Session(member, email));
    }
    if (grant === 'refresh_token') {
      const t = h4Verify(body.refresh_token, 'refresh');
      return t ? send(res, 200, h4Session(t.sub, t.email)) : send(res, 400, { error: 'invalid_grant' });
    }
    return send(res, 400, { error: 'unsupported_grant_type' });
  }
  if (p === '/functions/v1/healthkit-ingest' && req.method === 'POST') {
    const t = h4Verify((/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1], 'access');
    if (!t) return send(res, 401, { error: 'unauthorized' });
    const body = await readBody(req);
    if (body.ping) return send(res, 200, { ok: true });
    // 不声明 merged_hours_v1，App 就逐条发原始样本，按来源取最大值由 rebuildDay 处理
    if (!Array.isArray(body.samples) || !body.samples.length) return send(res, 200, { inserted: 0, capabilities: [] });
    const r = ingestHealth4ai(t.sub, body);
    persist(state);
    console.log(new Date().toISOString(), 'health4ai', t.sub, r);
    return send(res, 200, { inserted: r.new, capabilities: [] });
  }
  return false;
}

/* ---------- 原件：存在 data/files/<记录>/，看板和「给医生看」的分享链接都从这里读 ----------
 * 大照片和 HEIC 另存一份 <原名>.preview.jpg，页面优先显示它，原件仍可下载。 */
const FILES_DIR = path.join(DATA_DIR, 'files');
const MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', zip: 'application/zip', txt: 'text/plain; charset=utf-8' };
const mimeOf = n => MIME[(path.extname(n).slice(1) || '').toLowerCase()] || 'application/octet-stream';
const okId = s => /^[\w-]{1,80}$/.test(s || '');
const okName = s => !!s && s === path.basename(s) && !/^\.|[\0/\\]/.test(s) && s.length <= 200;
/* 月经：Apple 健康里记录的经期（menstrualFlow）按天整理，页面和手动记录合并显示 */
const FLOW = { 1: '有', 2: '少', 3: '中', 4: '多' };
function menstrualDays() {
  const out = {};
  for (const m of state.members) {
    let txt; try { txt = fs.readFileSync(path.join(RAW_DIR, m.id, 'menstrualFlow.ndjson'), 'utf8'); } catch (e) { continue; }
    const by = {};
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let x; try { x = JSON.parse(line); } catch (e) { continue; }
      if (!FLOW[x.value]) continue;
      const d = localDay(x.start);
      by[d] = { date: d, flow: FLOW[x.value], start: !!(x.metadata && +x.metadata.HKMenstrualCycleStart === 1) || (by[d] && by[d].start) || false };
    }
    const days = Object.values(by).sort((a, b) => a.date < b.date ? -1 : 1);
    if (days.length) out[m.id] = days;
  }
  return out;
}
/* 周期相关症状：Apple 健康「周期跟踪」里记的症状（value 1 = 没有，其余为有；2–4 是轻 / 中 / 重） */
const HK_SYM = { abdominalCramps: '腹痛 / 痛经', bloating: '腹胀', breastPain: '乳房胀痛', headache: '头痛', moodChanges: '情绪波动', lowerBackPain: '腰痛', pelvicPain: '盆腔痛',
  acne: '长痘', fatigue: '疲劳', sleepChanges: '睡眠变化', appetiteChanges: '食欲变化', nausea: '恶心', diarrhea: '腹泻', constipation: '便秘', chills: '发冷', hotFlashes: '潮热',
  dizziness: '头晕', generalizedBodyAche: '全身酸痛', vomiting: '呕吐', drySkin: '皮肤干燥', hairLoss: '掉发', nightSweats: '盗汗', memoryLapse: '健忘', vaginalDryness: '阴道干涩' };
const HK_SEV = { 2: '轻', 3: '中', 4: '重' };
function hkSymptoms() {
  const out = {};
  for (const m of state.members) {
    const by = {};
    for (const [t, name] of Object.entries(HK_SYM)) {
      let txt; try { txt = fs.readFileSync(path.join(RAW_DIR, m.id, t + '.ndjson'), 'utf8'); } catch (e) { continue; }
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        let x; try { x = JSON.parse(line); } catch (e) { continue; }
        if (+x.value === 1) continue;
        const d = localDay(x.start); by[t + d] = { date: d, type: t, name, sev: HK_SEV[x.value] || '' };
      }
    }
    const arr = Object.values(by).sort((a, b) => a.date < b.date ? -1 : 1);
    if (arr.length) out[m.id] = arr;
  }
  return out;
}
function fileIndex() {
  const out = {};
  let recs = []; try { recs = fs.readdirSync(FILES_DIR); } catch (e) { return out; }
  for (const r of recs) {
    if (!okId(r)) continue;
    let names = []; try { names = fs.readdirSync(path.join(FILES_DIR, r)); } catch (e) { continue; }
    const list = names.filter(n => !n.endsWith('.preview.jpg') && !n.endsWith('.tmp')).sort().map(n => {
      const st = fs.statSync(path.join(FILES_DIR, r, n));
      return { name: n, size: st.size, type: mimeOf(n), preview: names.includes(n + '.preview.jpg') ? n + '.preview.jpg' : null };
    });
    if (list.length) out[r] = list;
  }
  return out;
}
function sendFile(req, res, rec, name, download) {
  if (!okId(rec) || !okName(name)) return send(res, 400, { error: '文件名不对' });
  const p = path.join(FILES_DIR, rec, name);
  let st; try { st = fs.statSync(p); } catch (e) { return send(res, 404, { error: '没有这个文件' }); }
  res.writeHead(200, { 'Content-Type': mimeOf(name), 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(name.replace(/\.preview\.jpg$/, '.jpg')) });
  fs.createReadStream(p).pipe(res);
}
async function saveFile(req, rec, name) {
  const buf = await readRaw(req);
  fs.mkdirSync(path.join(FILES_DIR, rec), { recursive: true });
  const p = path.join(FILES_DIR, rec, name);
  fs.writeFileSync(p + '.tmp', buf); fs.renameSync(p + '.tmp', p);
  return buf.length;
}

/* 给医生看：每条档案可生成一个有效期内免密码的链接，只能看这一条档案和它的原件，可随时停止 */
const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function shareOf(token) {
  const s = (state.shares || []).find(x => x.token === token);
  return s && !s.revoked && Date.parse(s.expires) > Date.now() ? s : null;
}
function sharePage(sh) {
  const r = state.records.find(x => x.id === sh.record_id) || {};
  const m = state.members.find(x => x.id === r.member_id) || {};
  const cs = state.clinical.filter(c => c.record_id === r.id);
  const labs = cs.filter(c => typeof c.value === 'number'), finds = cs.filter(c => typeof c.value !== 'number' && c.finding);
  const files = fileIndex()[r.id] || [];
  const base = encodeURIComponent(sh.token) + '/f/';
  const ref = c => c.ref_low != null && c.ref_high != null ? c.ref_low + '–' + c.ref_high : c.ref_low != null ? '≥ ' + c.ref_low : c.ref_high != null ? '≤ ' + c.ref_high : '';
  const fileHtml = files.map(f => {
    const u = base + encodeURIComponent(f.name), v = f.preview ? base + encodeURIComponent(f.preview) : u;
    if (/^image\//.test(f.type) && (f.preview || f.type !== 'image/heic')) return '<figure><a href="' + v + '" target="_blank"><img src="' + v + '" loading="lazy" alt="' + escH(f.name) + '"></a><figcaption>' + escH(f.name) + ' · <a href="' + u + '?download=1">下载原件</a></figcaption></figure>';
    if (f.type === 'application/pdf') return '<p class="file">📄 <a href="' + u + '" target="_blank">' + escH(f.name) + '</a>（点开查看）</p>';
    return '<p class="file">📦 <a href="' + u + '?download=1">' + escH(f.name) + '</a>（' + (f.size / 1048576).toFixed(1) + ' MB，下载）' + (/\.zip$/i.test(f.name) ? ' 影像原始数据（DICOM），可用医院或电脑上的看片软件打开' : '') + '</p>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>' + escH(r.title || '检查资料') + '</title><style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f3f6f4;color:#19231f;line-height:1.6}' +
    'main{max-width:860px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:0 0 4px}.meta{color:#64716b;font-size:14px}section{background:#fff;border:1px solid #e2e8e4;border-radius:12px;padding:14px 16px;margin-top:14px}' +
    'h2{font-size:15px;margin:0 0 8px}table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 8px;border-bottom:1px solid #e2e8e4;text-align:left}th{color:#64716b;font-weight:500;font-size:12px}' +
    'figure{margin:0 0 14px}img{max-width:100%;border-radius:8px;border:1px solid #e2e8e4}figcaption{font-size:12px;color:#64716b}.file{margin:6px 0}.note{font-size:12px;color:#9aa59f;margin-top:16px}a{color:#2e7558}</style></head><body><main>' +
    '<h1>' + escH(r.title || '') + '</h1><div class="meta">' + escH(m.name || '') + ' · ' + escH(r.date || '') + ' · ' + escH(r.org || '') + (r.type ? ' · ' + escH(r.type) : '') + '</div>' +
    '<section><h2>原件</h2>' + (fileHtml || '<p class="meta">没有上传原件</p>') + '</section>' +
    (finds.length ? '<section><h2>检查结论</h2>' + finds.map(c => '<p><b>' + escH(c.name) + '</b>：' + escH(c.finding) + '</p>').join('') + '</section>' : '') +
    (labs.length ? '<section><h2>化验结果</h2><table><tr><th>项目</th><th>结果</th><th>参考范围</th></tr>' + labs.map(c => '<tr><td>' + escH(c.name) + '</td><td>' + c.value + ' ' + escH(c.unit || '') + '</td><td>' + escH(ref(c)) + '</td></tr>').join('') + '</table></section>' : '') +
    '<p class="note">家庭健康档案分享，链接 ' + escH(sh.expires.slice(0, 10)) + ' 前有效。结构化结果由原件整理，以原件为准。</p></main></body></html>';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/auth/v1/') || url.pathname.startsWith('/functions/v1/')) { if (await health4aiRoute(req, res, url) !== false) return; return send(res, 404, { error: 'not found' }); }

    if (url.pathname === '/api/ingest/shortcut' && req.method === 'POST') {
      const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      if (!INGEST_TOKEN || !auth || !safeEq(auth[1].trim(), INGEST_TOKEN)) return send(res, 401, { error: '口令不对' });
      const member = url.searchParams.get('member') || 'me';
      if (!state.members.some(m => m.id === member)) return send(res, 400, { error: '没有这个成员：' + member });
      const r = ingestShortcut(member, await readBody(req));
      persist(state);
      console.log(new Date().toISOString(), 'shortcut', member, r);
      return send(res, 200, { ok: true, ...r });
    }
    if (url.pathname === '/api/ingest/apple-health' && req.method === 'POST') {
      const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      if (!INGEST_TOKEN || !auth || !safeEq(auth[1].trim(), INGEST_TOKEN)) return send(res, 401, { error: '口令不对' });
      const member = url.searchParams.get('member') || 'me';
      if (!state.members.some(m => m.id === member)) return send(res, 400, { error: '没有这个成员：' + member });
      const r = ingestAppleHealth(member, await readBody(req));
      persist(state);
      console.log(new Date().toISOString(), 'apple-health', member, r);
      return send(res, 200, { ok: true, ...r });
    }

    // Pulso：App 里服务器地址填 https://<域名>/pulso/<成员>，它会访问 /ingest、/health、/latest
    const pm = /^\/pulso\/([A-Za-z0-9_-]+)\/(ingest|health|latest)$/.exec(url.pathname);
    if (pm) {
      const [, member, op] = pm;
      if (op === 'health') return send(res, 200, { ok: true });
      const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      if (!INGEST_TOKEN || !auth || !safeEq(auth[1].trim(), INGEST_TOKEN)) return send(res, 401, { error: 'unauthorized' });
      if (!state.members.some(m => m.id === member)) return send(res, 404, { error: 'unknown member' });
      if (op === 'latest' && req.method === 'GET') return send(res, 200, Object.fromEntries(Object.entries(memberStore(member).latest).map(([k, v]) => [k, v[1]])));
      if (op === 'ingest' && req.method === 'POST') {
        let buf = await readRaw(req);
        if (/gzip/i.test(req.headers['content-encoding'] || '')) buf = zlib.gunzipSync(buf, { maxOutputLength: 200 * 1024 * 1024 });
        let items; try { items = JSON.parse(buf.toString('utf8')); } catch (e) { return send(res, 400, { error: 'bad json' }); }
        if (!Array.isArray(items)) return send(res, 400, { error: 'not an array' });
        const r = ingestPulso(member, items);
        persist(state);
        console.log(new Date().toISOString(), 'pulso', member, r);
        return send(res, 200, r);
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    // 给医生看的分享链接：不需要家庭密码，只认链接里的随机口令
    const sm = /^\/s\/([A-Za-z0-9_-]{16,64})(?:\/f\/([^/]+))?$/.exec(url.pathname);
    if (sm && req.method === 'GET') {
      const sh = shareOf(sm[1]);
      if (!sh) return send(res, 404, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><p style="font-family:sans-serif;padding:24px">这个链接已过期或已停止分享。</p>', 'text/html; charset=utf-8');
      if (!sm[2]) return send(res, 200, sharePage(sh), 'text/html; charset=utf-8');
      const name = decodeURIComponent(sm[2]);
      if (!(fileIndex()[sh.record_id] || []).some(f => f.name === name || f.preview === name)) return send(res, 404, { error: '没有这个文件' });
      return sendFile(req, res, sh.record_id, name, url.searchParams.has('download'));
    }

    if (!pageAuthorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="PP health book", charset="UTF-8"' }); return res.end(); }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const { unknownMetrics, ...pub } = state;
      return send(res, 200, { ...pub, files: fileIndex(), backup: backupInfo(), menstrual: menstrualDays(), hkSymptoms: hkSymptoms() });
    }
    const fm = /^\/api\/files\/([\w-]{1,80})\/([^/]+)$/.exec(url.pathname);
    if (fm) {
      const rec = fm[1], name = decodeURIComponent(fm[2]);
      if (!okName(name)) return send(res, 400, { error: '文件名不对' });
      if (req.method === 'GET') return sendFile(req, res, rec, name, url.searchParams.has('download'));
      if (req.method === 'PUT') { const size = await saveFile(req, rec, name); return send(res, 200, { ok: true, size }); }
      if (req.method === 'DELETE') {
        // 不直接删除：移到 backups/trash，误删可以找回
        const trash = path.join(BACKUP_DIR, 'trash'); fs.mkdirSync(trash, { recursive: true });
        for (const n of [name, name + '.preview.jpg']) { try { fs.renameSync(path.join(FILES_DIR, rec, n), path.join(trash, Date.now() + '__' + rec + '__' + n)); } catch (e) {} }
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'method not allowed' });
    }
    if (url.pathname === '/api/share' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.revoke) { const s = (state.shares || []).find(x => x.token === body.revoke); if (s) s.revoked = true; persist(state); return send(res, 200, { ok: true }); }
      if (!state.records.some(r => r.id === body.record_id)) return send(res, 400, { error: '没有这条档案' });
      const days = Math.min(90, Math.max(1, +body.days || 7));
      const sh = { token: crypto.randomBytes(18).toString('base64url'), record_id: body.record_id, created: new Date().toISOString(), expires: new Date(Date.now() + days * 864e5).toISOString() };
      state.shares = (state.shares || []).filter(s => !s.revoked && Date.parse(s.expires) > Date.now()).concat(sh);
      persist(state);
      return send(res, 200, { ok: true, ...sh });
    }
    if (url.pathname === '/api/checkin' && req.method === 'POST') {
      const body = await readBody(req);
      backupState('checkin');
      return send(res, 200, { ok: true, ...ingestCheckin(body) });
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const body = await readBody(req);
      backupState('sync');
      for (const k of USER_TABLES) if (body[k] !== undefined) {
        const ok = ['reminders', 'sources'].includes(k) ? body[k] && typeof body[k] === 'object' && !Array.isArray(body[k]) : Array.isArray(body[k]);
        if (ok) state[k] = MERGE_TABLES.includes(k) ? mergeById(state[k], body[k]) : body[k];
      }
      persist(state);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return send(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, { error: e.code === 413 ? '数据太大' : e.code === 400 ? '格式不对' : '服务器出错' });
  }
});

if (require.main === module) {
  if (!INGEST_TOKEN) console.warn('提醒：没有设置 INGEST_TOKEN，Apple Watch 推送会被拒绝');
  server.listen(PORT, () => console.log("PP's健康簿 已启动，端口 " + PORT));
  weeklyBackup(); setInterval(weeklyBackup, 6 * 3600e3);
  if (FREEREPS_PORT) http.createServer(freeRepsHandler).listen(FREEREPS_PORT, process.env.FREEREPS_BIND || '127.0.0.1', () => console.log('FreeReps 接口（仅 Tailscale）端口 ' + FREEREPS_PORT));
}
module.exports = { ingestFreeReps, ingestHealth4ai, ingestShortcut, ingestAppleHealth, ingestPulso, _state: () => state, _reset: () => { state = emptyState(); } };

"""生成一份虚构家庭的演示数据（林小禾一家，人名、数值全部是编的），用来本地试用和截图。
用法：python3 scripts/make_demo_data.py demo-data
然后：PORT=3000 DATA_DIR=demo-data node server/server.js，打开 http://localhost:3000"""
import json, math, os, random, sys, datetime as dt

OUT = sys.argv[1] if len(sys.argv) > 1 else 'demo-data'
TZ = dt.timezone(dt.timedelta(hours=8))
random.seed(20261107)
TODAY = dt.datetime.now(TZ).date()
D = lambda n: (TODAY - dt.timedelta(days=n)).isoformat()
N = 150
def utc(day, minutes):
    """当地日期 day 的 0 点加 minutes 分钟（可以超过 24 小时）→ UTC ISO 字符串"""
    t = dt.datetime.combine(dt.date.fromisoformat(day), dt.time(0), TZ) + dt.timedelta(minutes=minutes)
    return t.astimezone(dt.timezone.utc).isoformat().replace('+00:00', 'Z')

# 月经周期：每 28–31 天一次，经期 5 天
starts, d = [], TODAY - dt.timedelta(days=N + 10)
while d <= TODAY:
    starts.append(d); d += dt.timedelta(days=random.choice([28, 29, 29, 30, 31]))
def cycle_day(day):
    s = max([x for x in starts if x <= day], default=None)
    return (day - s).days + 1 if s else None

daily, segments, mflow, hk = [], [], [], {'headache': [], 'breastPain': [], 'bloating': []}
for i in range(N, -1, -1):
    day = TODAY - dt.timedelta(days=i); ds = day.isoformat(); cd = cycle_day(day) or 10
    lut = cd >= 17
    bed = 23 * 60 + 45 + random.gauss(0, 50) + (25 if day.weekday() in (4, 5) else 0)   # 前一晚入睡（相对前一天 0 点）
    dur = max(250, min(560, random.gauss(415 - (25 if cd >= 24 else 0), 45)))
    prev = (day - dt.timedelta(days=1)).isoformat()
    deep = int(dur * random.uniform(.13, .19)); rem = int(dur * random.uniform(.2, .26)); awake = random.randint(5, 25)
    segments.append({'id': 'sleep_me_' + ds, 'member_id': 'me', 'kind': 'sleep', 'type': '睡眠', 'start': ds, 'duration_min': round(dur), 'deep': deep, 'rem': rem,
                     'core': round(dur) - deep - rem, 'awake': awake, 'sleep_start': utc(prev, bed), 'sleep_end': utc(prev, bed + dur + awake), 'source': 'Apple Watch'})
    workouts = []
    if day.weekday() in (1, 5) and random.random() < .85: workouts.append(('网球', 19 * 60 + 10, random.randint(60, 100)))
    if day.weekday() == 3 and random.random() < .7: workouts.append(('力量训练', 12 * 60 + 20, random.randint(35, 50)))
    if day.weekday() == 6 and random.random() < .5: workouts.append(('跑步', 8 * 60, random.randint(25, 40)))
    for t, st, mins in workouts:
        segments.append({'id': 'wk_demo_' + ds + t, 'member_id': 'me', 'kind': 'workout', 'day': ds, 'type': t, 'start': utc(ds, st)[:16], 'duration_min': mins,
                         'avg_hr': random.randint(128, 150), 'max_hr': random.randint(165, 182), 'energy': mins * 7, 'source': 'Apple Watch'})
    wm = sum(m for _, _, m in workouts)
    steps = int(random.gauss(7200, 2000) + wm * 70)
    w = 56.4 - .006 * (N - i) + .25 * math.sin(i / 6) + (.4 if cd >= 25 or cd <= 2 else 0) + random.gauss(0, .2)
    row = {'date': ds, 'member_id': 'me', 'source': 'Apple Health', 'real': True, 'body_fat_method': 'BIA',
           'weight': round(w, 1) if random.random() < .7 else None,
           'body_fat': round(25.2 - .004 * (N - i) + random.gauss(0, .5), 1) if random.random() < .6 else None,
           'sleep_total': round(dur), 'sleep_deep': deep, 'sleep_rem': rem,
           'resting_hr': round(60 + (2 if lut else 0) - (dur - 415) / 60 + random.gauss(0, 1.5)),
           'walking_hr': round(92 + random.gauss(0, 3)), 'hrv': round(52 - (4 if lut else 0) + (dur - 415) / 12 + random.gauss(0, 6)),
           'steps': max(800, steps), 'active_energy': max(80, int(steps * .035 + wm * 6)), 'exercise_minutes': wm + random.randint(5, 20),
           'workout_minutes': wm or None, 'workout_count': len(workouts) or None, 'resp_rate': round(15.4 + random.gauss(0, .4), 1), 'spo2': random.choice([96, 97, 97, 98]),
           'vo2max': round(38 + random.gauss(0, .5), 1) if i % 9 == 0 else None, 'wrist_temp': None}
    if i in (12, 30):   # 两个体脂秤的离群读数，页面会自动剔除
        row['weight'] = round(w, 1); row['body_fat'] = round(random.uniform(15, 17), 1)
    daily.append(row)
    if cd <= 5:
        mflow.append({'uuid': 'demo-mf-' + ds, 'type': 'menstrualFlow', 'start': utc(ds, 8 * 60), 'end': utc(ds, 8 * 60), 'value': [3, 4, 3, 2, 2][cd - 1], 'metadata': {'HKMenstrualCycleStart': 1 if cd == 1 else 0}})
        if cd <= 2 and random.random() < .6: hk['headache'].append({'uuid': 'demo-hd-' + ds, 'type': 'headache', 'start': utc(ds, 15 * 60), 'value': 0})
    if 25 <= cd <= 28 and random.random() < .35: hk['breastPain'].append({'uuid': 'demo-bp-' + ds, 'type': 'breastPain', 'start': utc(ds, 10 * 60), 'value': 0})
    if cd in (1, 2) and random.random() < .4: hk['bloating'].append({'uuid': 'demo-bl-' + ds, 'type': 'bloating', 'start': utc(ds, 11 * 60), 'value': 0})

def C(mid, rid, date, name, value, unit, lo, hi, region, method='', src='示例体检中心'):
    return {'id': 'cm_%s_%s_%s' % (mid, rid, abs(hash(name)) % 10**6), 'member_id': mid, 'record_id': rid, 'date': date, 'name': name, 'value': value, 'unit': unit,
            'ref_low': lo, 'ref_high': hi, 'method': method, 'source': src, 'kind': 'lab', 'region': region, 'finding': '', 'user': True}
def I(mid, rid, date, name, region, finding, method, kind='imaging', src='示例体检中心'):
    return {'id': 'cm_%s_%s_%s' % (mid, rid, abs(hash(name)) % 10**6), 'member_id': mid, 'record_id': rid, 'date': date, 'name': name, 'value': None, 'unit': '',
            'ref_low': None, 'ref_high': None, 'method': method, 'source': src, 'kind': kind, 'region': region, 'finding': finding, 'user': True}
R = lambda id, mid, date, org, typ, title, note='': {'id': id, 'member_id': mid, 'date': date, 'org': org, 'type': typ, 'title': title, 'files': [], 'note': note, 'user': True}
records = [R('r_me_ck1', 'me', D(205), '示例体检中心', '体检', '年度体检'), R('r_me_ck0', 'me', D(570), '示例体检中心', '体检', '年度体检'),
           R('r_me_vd', 'me', D(40), '示例医院 检验科', '检查', '维生素 D 复查'), R('r_me_derm', 'me', D(120), '示例医院 皮肤科', '门诊', '皮肤科门诊：面部痘痘'),
           R('r_me_ipl', 'me', D(95), '示例医美诊所', '医美', '光子嫩肤', '注意事项：一周内加强保湿防晒'), R('r_mom_ck', 'mom', D(160), '示例体检中心', '体检', '年度体检'),
           R('r_mom_dxa', 'mom', D(150), '示例医院 核医学科', '检查', '骨密度（DXA）'), R('r_dad_ck', 'dad', D(140), '示例体检中心', '体检', '年度体检'),
           R('r_dad_cta', 'dad', D(120), '示例医院 心内科', '检查', '冠脉 CTA')]
clinical = [
    C('me', 'r_me_ck0', D(570), '25-羟基维生素 D', 16.2, 'ng/mL', 20, None, 'blood'), C('me', 'r_me_ck1', D(205), '25-羟基维生素 D', 18.5, 'ng/mL', 20, None, 'blood'),
    C('me', 'r_me_vd', D(40), '25-羟基维生素 D', 27.8, 'ng/mL', 20, None, 'blood', src='示例医院 检验科'),
    C('me', 'r_me_ck1', D(205), '血红蛋白', 121, 'g/L', 115, 150, 'blood'), C('me', 'r_me_ck1', D(205), '铁蛋白', 32, 'ng/mL', 13, 150, 'blood'),
    C('me', 'r_me_ck1', D(205), '促甲状腺激素 TSH', 2.3, 'mIU/L', .27, 4.2, 'neck'), C('me', 'r_me_ck1', D(205), '低密度脂蛋白 LDL-C', 2.4, 'mmol/L', None, 3.4, 'blood'),
    C('me', 'r_me_ck1', D(205), '空腹血糖', 4.8, 'mmol/L', 3.9, 6.1, 'blood'), C('me', 'r_me_ck1', D(205), '丙氨酸氨基转移酶 ALT', 18, 'U/L', 7, 40, 'abdomen'),
    C('me', 'r_me_ck0', D(570), '丙氨酸氨基转移酶 ALT', 21, 'U/L', 7, 40, 'abdomen'),
    I('me', 'r_me_ck1', D(205), '乳腺 B 超', 'chest', '双侧乳腺增生，BI-RADS 2 类。', '超声'), I('me', 'r_me_ck1', D(205), '甲状腺 B 超', 'neck', '甲状腺左叶低回声结节 3×2 mm，TI-RADS 3 类，建议定期复查。', '超声'),
    I('me', 'r_me_ck1', D(205), '子宫附件 B 超', 'pelvis', '子宫、双附件未见明显异常。', '超声'), I('me', 'r_me_derm', D(120), '面部皮肤', 'skin', '轻度痤疮，以下颌为主。', '', 'exam', '示例医院 皮肤科'),
    I('me', 'r_me_ipl', D(95), '光子嫩肤', 'face', '面部光子嫩肤一次。', '', 'exam', '示例医美诊所'),
    C('mom', 'r_mom_ck', D(160), '空腹血糖', 6.4, 'mmol/L', 3.9, 6.1, 'blood'), C('mom', 'r_mom_ck', D(160), '低密度脂蛋白 LDL-C', 3.6, 'mmol/L', None, 3.4, 'blood'),
    I('mom', 'r_mom_ck', D(160), '乳腺 B 超', 'chest', '双侧乳腺增生，BI-RADS 2 类。', '超声'), C('mom', 'r_mom_dxa', D(150), '腰椎 L1–L4 T 值', -1.6, 'T', -1, None, 'spine', 'DXA', '示例医院 核医学科'),
    C('dad', 'r_dad_ck', D(140), '低密度脂蛋白 LDL-C', 3.8, 'mmol/L', None, 3.4, 'blood'), C('dad', 'r_dad_ck', D(140), '尿酸', 455, 'μmol/L', 208, 428, 'kidney'),
    I('dad', 'r_dad_cta', D(120), '冠脉 CTA', 'chest', '左前降支近段轻度非钙化斑块，管腔狭窄小于 25%。', 'CT', src='示例医院 心内科')]
plans = [
    {'id': 'pl_me_thy', 'member_id': 'me', 'status': 'recheck', 'date': D(-25), 'title': '复查甲状腺 B 超（结节随访）', 'origin': '系统按报告结果建议', 'note': '常见间隔 6–12 个月', 'record_id': 'r_me_ck1', 'source_kind': 'system', 'user': True, 'log': []},
    {'id': 'pl_me_year', 'member_id': 'me', 'status': 'future', 'date': D(-160), 'title': '年度体检', 'origin': '手动（每年）', 'note': '', 'repeat_months': 12, 'source_kind': 'self', 'user': True, 'log': []},
    {'id': 'pl_me_vd', 'member_id': 'me', 'status': 'done', 'date': D(40), 'title': '复查维生素 D', 'origin': '系统按报告结果建议', 'note': '已完成', 'record_id': 'r_me_ck1', 'source_kind': 'system', 'user': True, 'log': []},
    {'id': 'pl_dad_lipid', 'member_id': 'dad', 'status': 'recheck', 'date': D(-10), 'title': '复查血脂、尿酸', 'origin': '医生原话', 'note': '心内科复诊', 'source_kind': 'doctor', 'user': True, 'log': []}]
meds = [
    {'id': 'supp_me_d3', 'member_id': 'me', 'cat': 'supplement', 'kind': 'long', 'name': '维生素 D3 软胶囊（示例品牌）', 'alias': ['D3', '维D'], 'nutrients': [{'name': '维生素 D3', 'amount': 2000, 'unit': 'IU', 'key': 'vitd'}],
     'dose': '每次 1 粒', 'freq': '每天 1 次', 'reason': '维生素 D 偏低', 'start': D(200), 'end': '', 'source': 'self', 'user': True},
    {'id': 'supp_me_fo', 'member_id': 'me', 'cat': 'supplement', 'kind': 'long', 'name': '鱼油（示例品牌）', 'alias': ['鱼油'], 'nutrients': [{'name': 'EPA', 'amount': 360, 'unit': 'mg', 'key': 'omega3'}, {'name': 'DHA', 'amount': 240, 'unit': 'mg', 'key': 'omega3'}],
     'dose': '每次 1 粒', 'freq': '每天 1 次', 'reason': '', 'start': D(90), 'end': '', 'source': 'self', 'user': True},
    {'id': 'med_dad_statin', 'member_id': 'dad', 'kind': 'long', 'name': '阿托伐他汀钙片', 'dose': '20mg', 'freq': '每晚 1 次', 'start': D(118), 'end': '', 'reason': '降血脂（冠脉轻度斑块）', 'source': 'doctor', 'record_id': 'r_dad_cta', 'user': True}]
MEALS = [('早餐', ['燕麦牛奶杯', '鸡蛋']), ('早餐', ['全麦面包', '鸡蛋', '酸奶']), ('午餐', ['牛肉饭', '青菜']), ('午餐', ['鸡胸肉沙拉', '玉米']), ('午餐', ['番茄炒蛋', '米饭', '西兰花']),
         ('晚餐', ['三文鱼', '红薯', '菠菜']), ('晚餐', ['豆腐汤', '杂粮饭', '清炒时蔬']), ('晚餐', ['虾仁', '荞麦面']), ('加餐', ['苹果']), ('加餐', ['奶茶'])]
checkins = []
for i in range(9, -1, -1):
    ds = D(i); dd = dt.date.fromisoformat(ds); ws = [s for s in segments if s['kind'] == 'workout' and s['day'] == ds]
    meals = [{'meal': '早餐', 'items': random.choice([m for m in MEALS if m[0] == '早餐'])[1]}, {'meal': '午餐', 'items': random.choice([m for m in MEALS if m[0] == '午餐'])[1]},
             {'meal': '晚餐', 'items': random.choice([m for m in MEALS if m[0] == '晚餐'])[1]}]
    if random.random() < .4: meals.append({'meal': '加餐', 'items': random.choice([m for m in MEALS if m[0] == '加餐'])[1]})
    if meals[0]['items'][0] == '燕麦牛奶杯': meals[0]['food_id'] = 'food_demo_oat'
    ck = {'id': 'ck_me_' + ds, 'member_id': 'me', 'date': ds, 'meals': meals, 'exercise': [{'type': w['type'], 'minutes': w['duration_min'], 'rpe': random.randint(5, 7)} for w in ws],
          'skin': {'note': random.choice(['下巴冒了一颗痘', 'T 区有点油', '状态不错', '脸颊有点干'])}, 'feel': random.choice(['精力不错', '一般', '有点累']),
          'supps': [{'name': 'D3'}] + ([{'name': '鱼油'}] if random.random() < .7 else []), 'energy': '1600–1900 kcal',
          'nutrients': {'protein': '70–85 g', 'fiber': '15–22 g', 'calcium': '约 500–700 mg', 'omega3': '约 300–1500 mg'},
          'status': 'pending' if i == 0 else 'confirmed', 'updated': ds + 'T22:00:00Z', 'created': ds + 'T22:00:00Z'}
    if random.random() < .3: ck['caffeine'] = [{'what': '拿铁', 'time': random.choice(['10:00', '15:30'])}]
    if i == 3: ck['care'] = ['补水面膜']
    checkins.append(ck)
state = {
    'version': 2, 'current': 'me', 'loginAs': 'me',
    'members': [
        {'id': 'me', 'name': '林小禾', 'account': 'primary', 'status': 'active', 'profile': {'birth': '1997-04-12', 'sex': '女', 'height': 165, 'blood': 'A型', 'allergy': '', 'chronic': '', 'history': '轻度过敏性鼻炎', 'surgery': '', 'meds': '', 'family': '外婆约 80 岁患乳腺癌（示例）', 'vaccine': '已完成 HPV 疫苗 3 针', 'note': ''}},
        {'id': 'mom', 'name': '周丽', 'account': 'sub', 'status': 'active', 'profile': {'birth': '1969-09-03', 'sex': '女', 'height': 158, 'blood': 'O型', 'history': '', 'family': ''}},
        {'id': 'dad', 'name': '林建国', 'account': 'sub', 'status': 'active', 'profile': {'birth': '1967-02-20', 'sex': '男', 'height': 175, 'blood': 'A型', 'history': '', 'family': ''}}],
    'daily': daily, 'segments': segments, 'clinical': clinical, 'symptoms': [], 'records': records, 'plans': plans, 'reports': [], 'meds': meds, 'cycles': [],
    'sources': {'me': {'apple': True, 'manual': True, 'reports': True}}, 'reminders': {'daily': True, 'weekly': True, 'plan': True, 'trend': True},
    'appleSync': {'me': {'last': dt.datetime.now(dt.timezone.utc).isoformat(), 'days': len(daily), 'via': 'health4.ai'}}, 'unknownMetrics': {}, 'shares': [],
    'checkins': checkins,
    'goals': [{'id': 'goal_demo_tennis', 'member_id': 'me', 'kind': 'plan', 'sport': '网球', 'per_week': 2, 'status': 'active', 'updated': D(30)},
              {'id': 'goal_demo_str', 'member_id': 'me', 'kind': 'plan', 'sport': '力量训练', 'per_week': 2, 'note': '核心和背部力量', 'status': 'active', 'updated': D(30)},
              {'id': 'goal_demo_w', 'member_id': 'me', 'title': '每周运动 3 次', 'metric': 'workouts_week', 'target': 3, 'start_value': 2, 'start': D(30), 'status': 'active', 'updated': D(30)},
              {'id': 'goal_demo_sleep', 'member_id': 'me', 'kind': 'sleephabit', 'title': '00:00 前入睡', 'before': '00:00', 'start': D(14), 'days': 30, 'status': 'active', 'updated': D(14)}],
    'routines': [{'id': 'rt_demo_mask', 'member_id': 'me', 'name': '补水面膜', 'match': '面膜', 'interval_days': 4, 'cat': '护肤', 'enabled': True, 'updated': D(3)},
                 {'id': 'rt_demo_bh', 'member_id': 'me', 'name': '去黑头', 'match': '黑头', 'interval_days': 14, 'last': D(16), 'cat': '护肤', 'enabled': True, 'updated': D(16)}],
    'products': [{'id': 'prod_demo_1', 'member_id': 'me', 'name': '氨基酸洁面（示例）', 'cat': '洁面', 'ingredients': ['氨基酸表活'], 'when': 'both', 'status': 'using', 'updated': D(60)},
                 {'id': 'prod_demo_2', 'member_id': 'me', 'name': '烟酰胺精华（示例）', 'cat': '精华', 'ingredients': ['烟酰胺', '泛醇'], 'when': 'both', 'status': 'using', 'updated': D(60)},
                 {'id': 'prod_demo_3', 'member_id': 'me', 'name': '水杨酸精华（示例）', 'cat': '精华', 'ingredients': ['水杨酸'], 'when': 'pm', 'status': 'using', 'updated': D(60)},
                 {'id': 'prod_demo_4', 'member_id': 'me', 'name': '神经酰胺面霜（示例）', 'cat': '面霜', 'ingredients': ['神经酰胺', '角鲨烷'], 'when': 'both', 'status': 'using', 'updated': D(60)},
                 {'id': 'prod_demo_5', 'member_id': 'me', 'name': '清爽防晒 SPF50（示例）', 'cat': '防晒', 'ingredients': [], 'when': 'am', 'status': 'using', 'updated': D(60)}],
    'foods': [{'id': 'food_demo_oat', 'member_id': 'me', 'name': '燕麦牛奶杯', 'items': ['燕麦', '牛奶', '奇亚籽', '蓝莓'], 'portion': '一杯约 350 ml', 'nutrients': '蛋白质 12–15 g', 'updated': D(20)}]}
os.makedirs(os.path.join(OUT, 'raw', 'me'), exist_ok=True)
json.dump(state, open(os.path.join(OUT, 'state.json'), 'w'), ensure_ascii=False)
for name, rows in [('menstrualFlow', mflow)] + list(hk.items()):
    with open(os.path.join(OUT, 'raw', 'me', name + '.ndjson'), 'w') as f:
        f.write(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows))
print('演示数据已生成到', OUT, '：', len(daily), '天，', len(checkins), '条每日记录')

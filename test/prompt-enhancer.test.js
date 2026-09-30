// prompt-enhancer.test.js — 图生图提示词自动增强（保护约束 + 冲突跳过）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceEditPrompt } from '../src/prompt-enhancer.js';

test('enhanceEditPrompt: 简单指令自动追加全约束', () => {
  const r = enhanceEditPrompt('让图片中的男生和女生互相拥抱');
  assert.equal(r.enhanced, true);
  assert.ok(r.prompt.includes('画面约束'));
  assert.ok(r.prompt.includes('面部特征'));
  assert.ok(r.prompt.includes('肢体与手指自然协调'));
  assert.ok(r.prompt.includes('文字、水印或 logo'));
  assert.equal(r.skipped.length, 0);
  // 原指令保持在前，未被改写
  assert.ok(r.prompt.startsWith('让图片中的男生和女生互相拥抱'));
});

test('enhanceEditPrompt: 用户明确改发型 → 跳过发型约束，其余照常', () => {
  const r = enhanceEditPrompt('给女生换个发型，让她笑起来');
  assert.equal(r.enhanced, true);
  assert.ok(r.skipped.includes('hair'));
  assert.ok(!r.prompt.includes('发型与发色不变'));
  assert.ok(r.prompt.includes('面部特征'));
});

test('enhanceEditPrompt: 用户明确换脸 → 跳过人脸约束', () => {
  const r = enhanceEditPrompt('把图片里的人换脸成另一个人');
  assert.ok(r.skipped.includes('face'));
  assert.ok(!r.prompt.includes('面部特征与五官完全不变'));
});

test('enhanceEditPrompt: 变瘦 → 定向身材约束（不整体跳过，未指定人物仍保护）', () => {
  const r = enhanceEditPrompt('让男生变瘦一点，女生保持不变');
  assert.ok(!r.skipped.includes('body'), JSON.stringify(r.skipped));
  assert.ok(r.prompt.includes('未被指令要求改动'), '应追加定向身材保护');
  assert.ok(r.prompt.includes('仅按指令调整指定的身材变化'));
});

test('enhanceEditPrompt: 只改男生体态 → 女生的面部/身材约束仍在', () => {
  const r = enhanceEditPrompt('男生身材要匀称偏瘦、不要像图中那样偏胖');
  assert.equal(r.enhanced, true);
  assert.ok(!r.skipped.includes('body'), '身材组应转为定向保护而非跳过');
  assert.ok(r.prompt.includes('未被指令要求改动'), '未指定人物身材仍受保护');
  assert.ok(r.prompt.includes('面部特征'), '面部保护不受影响');
});

test('enhanceEditPrompt: 校园风/校服 → 允许换装（跳过服饰保持）', () => {
  const campus = enhanceEditPrompt('衣服可以替换成校园风格');
  assert.ok(campus.skipped.includes('cloth'), JSON.stringify(campus.skipped));
  assert.ok(!campus.prompt.includes('保持人物原有服饰'), '允许换装时不得锁定原服饰');
  const uniform = enhanceEditPrompt('场景为大学校园，穿校服');
  assert.ok(uniform.skipped.includes('cloth'));
});

test('enhanceEditPrompt: 添加人物 → 跳过数量约束', () => {
  const r = enhanceEditPrompt('在背景加一个人');
  assert.ok(r.skipped.includes('count'));
  assert.ok(!r.prompt.includes('人物数量与身份不变'));
});

test('enhanceEditPrompt: 服装改动不触发跳过；明确改背景触发 scene 跳过', () => {
  // 换服装不在保护约束内 → 无跳过；"背景改成海边"是明确改场景 → scene 跳过
  const r = enhanceEditPrompt('把女生的裙子换成红色，背景改成海边');
  assert.equal(r.enhanced, true);
  assert.ok(r.skipped.includes('scene'), JSON.stringify(r.skipped));
});

test('enhanceEditPrompt: 未提服装 → 追加服饰保持；明确换装 → 跳过', () => {
  const keep = enhanceEditPrompt('生成一张校园照，男生骑自行车，女生在自行车后座侧坐');
  assert.ok(keep.prompt.includes('服饰'), '未提服装应追加服饰保持约束');
  const change = enhanceEditPrompt('把女生的裙子换成红色');
  assert.ok(change.skipped.includes('cloth'), JSON.stringify(change.skipped));
  assert.ok(!change.prompt.includes('服饰'), '明确换装应跳过服饰保持');
});

test('enhanceEditPrompt: 开关关闭 → 原样返回', () => {
  const r = enhanceEditPrompt('让图片里的两人牵手', { enabled: false });
  assert.equal(r.enhanced, false);
  assert.equal(r.prompt, '让图片里的两人牵手');
});

test('enhanceEditPrompt: 空指令 → 原样', () => {
  const r = enhanceEditPrompt('   ');
  assert.equal(r.enhanced, false);
  assert.equal(r.prompt, '');
});

test('enhanceEditPrompt: 侧着坐（自行车场景）→ 车身同侧展开', () => {
  const r = enhanceEditPrompt('女生在自行车后座侧着坐，双手抱着男生的腰');
  assert.equal(r.enhanced, true);
  assert.ok(r.prompt.includes('侧身坐姿'), '应展开侧坐为几何描述');
  assert.ok(r.prompt.includes('垂放在车身'), '自行车场景应描述车身同侧');
  assert.ok(r.prompt.includes('不是跨坐'), '应含反面示例');
  assert.ok(!r.skipped.includes('posture'), 'posture 从不跳过');
});

test('enhanceEditPrompt: 侧着坐（椅子场景）→ 双脚着地展开', () => {
  const r = enhanceEditPrompt('女生坐在椅子上侧着坐');
  assert.ok(r.prompt.includes('双脚着地或交叠'), '椅子场景应描述双脚着地');
  assert.ok(!r.prompt.includes('车身'), '椅子场景不得误用车身同侧描述');
});

test('enhanceEditPrompt: 侧着坐（骑马场景）→ 侧鞍式展开', () => {
  const r = enhanceEditPrompt('女生骑马，侧着坐');
  assert.ok(r.prompt.includes('马背同一侧'), '骑马场景应展开为侧鞍式');
});

test('enhanceEditPrompt: 侧着坐（无场景词）→ 通用展开', () => {
  const r = enhanceEditPrompt('让他侧着坐');
  assert.ok(r.prompt.includes('朝向一侧'), '无场景词用通用展开');
});

test('enhanceEditPrompt: 接吻 → 几何化展开（嘴唇贴合、错开鼻梁，不是脸贴脸）', () => {
  const r = enhanceEditPrompt('两个人拥抱在一起亲嘴');
  assert.ok(r.prompt.includes('嘴唇轻柔贴合'), '应展开接吻为具体描述');
  assert.ok(r.prompt.includes('错开鼻梁'), '应描述头部错位避免鼻梁打架');
  assert.ok(r.prompt.includes('不是脸贴脸错位'), '应含反面示例');
  assert.ok(r.prompt.includes('不是只碰肩膀'), '拥抱+亲吻共存：两者都展开');
});

test('enhanceEditPrompt: 亲吻 → 不依赖"拥抱"词直接展开', () => {
  const r = enhanceEditPrompt('两个人接吻');
  assert.ok(r.prompt.includes('嘴唇轻柔贴合'), '亲吻独立展开');
  assert.ok(!r.prompt.includes('手臂环绕对方身体'), '无拥抱/搂抱词 → 不展开拥抱');
});

test('enhanceEditPrompt: 组合姿态（公主抱+搂脖子+亲嘴）→ 三条全部几何化展开', () => {
  const r = enhanceEditPrompt('男生公主抱着女生，女生搂住男生的脖子，两个人在亲嘴');
  assert.ok(r.prompt.includes('一手托住女生肩背、一手托住其腿弯'), '公主抱展开（托抱几何化）');
  assert.ok(r.prompt.includes('不是背、不是扛、不是拦腰直抱'), '公主抱反例排除');
  assert.ok(r.prompt.includes('双臂环绕勾住男生的脖颈'), '搂脖子展开（不连续表述也命中）');
  assert.ok(r.prompt.includes('不是搭肩、不是抱腰'), '搂脖子反例排除');
  assert.ok(r.prompt.includes('嘴唇轻柔贴合'), '亲吻展开');
  assert.ok(!r.prompt.includes('两人相拥——手臂环绕对方身体'), '公主抱/搂脖子命中 → 通用拥抱被取代');
});

test('enhanceEditPrompt: 搂脖子独立触发（"搂住男生的脖子"不连续表述）', () => {
  const r = enhanceEditPrompt('女生搂住男生的脖子');
  assert.ok(r.prompt.includes('双臂环绕勾住男生的脖颈'), '搂脖子展开');
  assert.ok(!r.prompt.includes('两人相拥'), '搂脖子命中 → 拥抱被取代');
});

test('enhanceEditPrompt: 横抱 → 公主抱展开', () => {
  const r = enhanceEditPrompt('男生横抱女生');
  assert.ok(r.prompt.includes('一手托住女生肩背'), '横抱命中公主抱条目');
});

test('enhanceEditPrompt: 拥抱 → 追加动作几何展开', () => {
  const r = enhanceEditPrompt('让图片中的男生和女生互相拥抱');
  assert.ok(r.prompt.includes('手臂环绕对方身体'), '应展开拥抱动作');
});

test('enhanceEditPrompt: 骑车 → 注入动态+接触+脚蹬+多人互动细节（通用增强器）', () => {
  const r = enhanceEditPrompt('让两人骑车去校园');
  assert.ok(r.prompt.includes('场景动态细节'), '应注入场景动态细节段');
  assert.ok(r.prompt.includes('动态进行中'), '移动类动词 → 动态增强');
  assert.ok(r.prompt.includes('接触处真实贴合'), '接触类动词 → 接触物理增强');
  assert.ok(r.prompt.includes('一前一后高低错落'), '载具类 → 脚蹬高低');
  assert.ok(r.prompt.includes('多人互动细节'), '两人 → 多人互动增强');
  assert.ok(!r.prompt.includes('后座乘员臀部实坐'), '未提后座/载人 → 不注入后座细节');
});

test('enhanceEditPrompt: 提到后座乘员 → 追加实坐不悬空细节', () => {
  const r = enhanceEditPrompt('男生骑车，女生坐在后座');
  assert.ok(r.prompt.includes('后座乘员臀部实坐'), '后座主题命中应注入实坐细节');
  assert.ok(r.prompt.includes('双脚悬垂不落地'), '应注入双脚悬垂约束');
  assert.ok(r.prompt.includes('动态进行中'), '骑车同时注入动态增强');
});

test('enhanceEditPrompt: 用户已写全细节 → 全部 skip，不重复注入', () => {
  const r = enhanceEditPrompt('自行车缓慢行驶中、车轮转动，男生双脚踩在脚蹬上且前低后高，女生臀部实坐后座、双脚悬垂不落地');
  assert.ok(!r.prompt.includes('场景动态细节'), '细节已写全时不重复注入');
});

test('enhanceEditPrompt: 跑步 → 注入动态细节（脚步交替腾空）', () => {
  const r = enhanceEditPrompt('两个人在操场上跑步');
  assert.ok(r.prompt.includes('脚步交替腾空'), '奔跑动态增强');
  assert.ok(r.prompt.includes('多人互动细节'), '两个人 → 多人互动增强');
});

test('enhanceEditPrompt: 坐着（无载具）→ 只注入接触物理增强', () => {
  const r = enhanceEditPrompt('把女生放到椅子上坐着');
  assert.ok(r.prompt.includes('不悬空、不漂浮、不穿模'), '接触类动词 → 接触物理');
  assert.ok(!r.prompt.includes('脚蹬'), '无载具词 → 不注入载具细节');
});

test('enhanceEditPrompt: 面对面说话 → 注入多人互动细节', () => {
  const r = enhanceEditPrompt('两个人面对面站着说话');
  assert.ok(r.prompt.includes('相对位置、朝向与身体接触关系'), '多人互动增强');
});

test('enhanceEditPrompt: 无复杂姿态词 → posture 用默认防御文本', () => {
  const r = enhanceEditPrompt('生成一张校园照，两人一起走路');
  assert.ok(r.prompt.includes('不得用其他常见姿势替换'), '默认防御文本保留');
});

test('enhanceEditPrompt: 背着 → 背展开（趴背环抱、双腿夹腰、托腿弯）', () => {
  const r = enhanceEditPrompt('男生背着女生在校园里走');
  assert.ok(r.prompt.includes('被背者趴在背者背上'), '背展开');
  assert.ok(r.prompt.includes('双臂环抱背者的肩膀或脖颈'), '环抱肩膀描述');
  assert.ok(r.prompt.includes('不是扛在肩上'), '反例排除扛');
});

test('enhanceEditPrompt: 扛着 → 扛展开（横搭肩头、头腿分垂）', () => {
  const r = enhanceEditPrompt('男生把女生扛在肩上');
  assert.ok(r.prompt.includes('身体横搭在扛者一侧肩膀上'), '扛展开');
  assert.ok(r.prompt.includes('不是公主抱'), '反例排除公主抱');
});

test('enhanceEditPrompt: 跷二郎腿 → 展开（脚踝搭膝盖）', () => {
  const r = enhanceEditPrompt('他坐在沙发上跷二郎腿');
  assert.ok(r.prompt.includes('脚踝或小腿搭在另一条腿的膝盖上方'), '跷腿展开');
  assert.ok(r.prompt.includes('不是盘腿'), '反例排除盘腿');
});

test('enhanceEditPrompt: 盘腿 → 展开（双脚置对侧大腿下）', () => {
  const r = enhanceEditPrompt('她盘腿坐在垫子上');
  assert.ok(r.prompt.includes('双腿交叉盘起'), '盘腿展开');
  assert.ok(r.prompt.includes('不是跷二郎腿'), '反例排除跷腿');
});

test('enhanceEditPrompt: 蹲/跪 → 分别展开（蹲=脚跟着地重心稳定；跪=膝盖小腿贴地）', () => {
  const squat = enhanceEditPrompt('他蹲在路边');
  assert.ok(squat.prompt.includes('双脚着地、膝盖弯曲下蹲'), '蹲展开');
  assert.ok(squat.prompt.includes('不是跪姿'), '蹲反例排除跪');
  const kneel = enhanceEditPrompt('他单膝跪地求婚');
  assert.ok(kneel.prompt.includes('膝盖与小腿贴地'), '跪展开');
  assert.ok(kneel.prompt.includes('不是蹲'), '跪反例排除蹲');
});

test('enhanceEditPrompt: 依偎/勾肩搭背 → 分别展开', () => {
  const snug = enhanceEditPrompt('女生依偎在男生怀里');
  assert.ok(snug.prompt.includes('倚靠另一方的肩膀或怀中'), '依偎展开');
  assert.ok(snug.prompt.includes('不是并肩站立'), '依偎反例');
  const arm = enhanceEditPrompt('两人勾肩搭背地走');
  assert.ok(arm.prompt.includes('手臂搭在对方一侧肩上'), '勾肩搭背展开');
  assert.ok(arm.prompt.includes('不是搂脖子'), '勾肩搭背反例');
});

test('enhanceEditPrompt: 背靠背/骑肩 → 分别展开', () => {
  const b2b = enhanceEditPrompt('两人背靠背坐在地上');
  assert.ok(b2b.prompt.includes('背部相贴'), '背靠背展开');
  assert.ok(b2b.prompt.includes('不是并肩'), '背靠背反例');
  const ride = enhanceEditPrompt('爸爸把儿子架在肩上');
  assert.ok(ride.prompt.includes('双腿分开骑坐在骑者的双肩上'), '骑肩展开');
  assert.ok(ride.prompt.includes('不是骑脖子'), '骑肩反例');
});

test('enhanceEditPrompt: 英文 hug → 触发拥抱展开（大小写不敏感）', () => {
  const r = enhanceEditPrompt('Make the man and woman HUG each other');
  assert.ok(r.prompt.includes('手臂环绕对方身体'), '英文 hug 触发拥抱展开');
  assert.ok(r.prompt.includes('画面约束'), '注入约束段');
});

test('enhanceEditPrompt: 英文 kiss → 触发接吻展开', () => {
  const r = enhanceEditPrompt('Two people kissing on a park bench');
  assert.ok(r.prompt.includes('嘴唇轻柔贴合'), '英文 kiss 触发接吻展开');
});

test('enhanceEditPrompt: 英文 piggyback → 触发背展开', () => {
  const r = enhanceEditPrompt('A man giving a piggyback ride to a woman');
  assert.ok(r.prompt.includes('被背者趴在背者背上'), '英文 piggyback 触发背展开');
});

test('enhanceEditPrompt: 英文游泳 → 注入水中细节', () => {
  const r = enhanceEditPrompt('A woman swimming in the pool');
  assert.ok(r.prompt.includes('水中细节'), '英文 swimming 触发水中细节');
  assert.ok(r.prompt.includes('浮力'), '浮力细节注入');
});

test('enhanceEditPrompt: 跳舞 → 注入舞蹈细节', () => {
  const r = enhanceEditPrompt('两个人在舞池里跳舞');
  assert.ok(r.prompt.includes('舞蹈细节'), '中文跳舞触发舞蹈细节');
});

test('enhanceEditPrompt: 滑雪 → 注入雪上细节', () => {
  const r = enhanceEditPrompt('他在雪地滑雪');
  assert.ok(r.prompt.includes('雪/冰上运动细节'), '滑雪触发雪上细节');
});

test('enhanceEditPrompt: 打篮球 → 注入球类细节', () => {
  const r = enhanceEditPrompt('男生在篮球场打篮球');
  assert.ok(r.prompt.includes('球类运动细节'), '球类触发运动细节');
});

test('enhanceEditPrompt: 弹钢琴 → 注入演奏细节', () => {
  const r = enhanceEditPrompt('女生在弹钢琴');
  assert.ok(r.prompt.includes('演奏细节'), '弹钢琴触发演奏细节');
});

test('enhanceEditPrompt: 躺着睡觉 → 注入躺卧细节', () => {
  const r = enhanceEditPrompt('女生躺在床上睡觉');
  assert.ok(r.prompt.includes('躺卧细节'), '睡觉触发躺卧细节');
});

test('enhanceEditPrompt: 英文 sit sideways → 触发侧坐展开（通用 fallback）', () => {
  const r = enhanceEditPrompt('The girl sits sideways on the bicycle');
  assert.ok(r.prompt.includes('侧身坐姿'), '英文 side sit 触发侧坐');
  assert.ok(r.prompt.includes('车身'), '自行车英文词命中场景分派');
});

test('enhanceEditPrompt: 英文子串不误触发（visit 不得命中 sit）', () => {
  const r = enhanceEditPrompt('We visit the park today');
  assert.ok(!r.prompt.includes('接触处真实贴合'), 'visit 不得误触发坐/接触细节');
});

test('enhanceEditPrompt: 英文子串不误触发（with 不得命中 hit 球类）', () => {
  const r = enhanceEditPrompt('The man with a woman is walking');
  assert.ok(!r.prompt.includes('球类运动细节'), 'with 不得误触发球类');
  assert.ok(r.prompt.includes('动态进行中'), 'walking 仍正常触发动态');
});

test('enhanceEditPrompt: 英文子串不误触发（career 不得命中 car 载具）', () => {
  const r = enhanceEditPrompt('He has a career in finance');
  assert.ok(!r.prompt.includes('脚蹬'), 'career 不得误触发载具细节');
});

test('enhanceEditPrompt: 英文子串不误触发（seahorse 不得命中 horse 骑马）', () => {
  const r = enhanceEditPrompt('A seahorse swimming in the tank');
  assert.ok(!r.prompt.includes('马背'), 'seahorse 不得误触发骑马');
});

test('enhanceEditPrompt: 单词边界仍正常命中（sits sideways on bike / hits the ball）', () => {
  const sit = enhanceEditPrompt('She sits sideways on the bicycle');
  assert.ok(sit.prompt.includes('侧身坐姿'), 'sits sideways 单词命中侧坐');
  assert.ok(sit.prompt.includes('车身'), 'bicycle 命中场景分派');
  const hit = enhanceEditPrompt('He hits the ball');
  assert.ok(hit.prompt.includes('球类运动细节'), 'hits 单词命中球类');
  const sits = enhanceEditPrompt('She sits on the bicycle');
  assert.ok(sits.prompt.includes('接触处真实贴合'), 'sits 命中接触物理增强（不是侧坐）');
  assert.ok(!sits.prompt.includes('侧身坐姿'), '裸 sits 不得误触发侧坐');
});

test('enhanceEditPrompt: 姿态几何化正向描述（公主抱+搂脖+接吻组合）', () => {
  const r = enhanceEditPrompt('男生把女生公主抱在怀里，女生的双臂搂着男生的脖子，两人正在深情接吻。');
  assert.ok(r.prompt.includes('姿态细节'), '输出姿态细节段');
  assert.ok(r.prompt.includes('托住她的大腿与膝弯'), '公主抱几何化');
  assert.ok(r.prompt.includes('勾住男生的脖颈'), '搂脖几何化');
  assert.ok(r.prompt.includes('嘴唇轻柔贴合'), '接吻几何化');
  assert.ok(r.prompt.includes('多姿态协调'), '多姿态组合协调句');
});

test('enhanceEditPrompt: 侧坐场景 visual 输出', () => {
  const r = enhanceEditPrompt('女生坐在自行车后座，侧着坐');
  assert.ok(r.prompt.includes('双腿并拢垂放在车身同侧'), '自行车场景 visual');
  const pose = r.prompt.slice(r.prompt.indexOf('姿态细节'), r.prompt.indexOf('场景动态细节'));
  assert.ok(pose.includes('双腿并拢垂放在车身同侧'), '姿态细节段含正向描述');
  assert.ok(!pose.includes('严格按指令执行'), '姿态细节段不含防御句');
});

test('enhanceEditPrompt: 短提示词 → 返回 notice 提醒宿主，且不代写画面细节', () => {
  const r = enhanceEditPrompt('让图片中的男生和女生互相拥抱');
  assert.ok(r.notice, '短提示词应返回 notice');
  assert.ok(r.notice.includes('提示词仅'), 'notice 指出字数');
  assert.ok(r.notice.includes('按提示词写作指南'), 'notice 指导宿主补细节');
  assert.ok(r.notice.includes('不会代写画面细节'), 'notice 声明插件不代写');
  assert.ok(!r.prompt.includes('细节描写：'), 'prompt 不得被插件代写细节段');
  assert.ok(!r.prompt.includes('高清细腻的写实质感'), 'prompt 不得被代写画质词');
  assert.ok(!r.prompt.includes('光线自然柔和'), 'prompt 不得被代写光影词');
  assert.ok(r.prompt.includes('画面约束'), '仍追加保护性边界约束');
});

test('enhanceEditPrompt: 用户已写足 50 字细节 → 无 notice', () => {
  const r = enhanceEditPrompt('让图片中的男生和女生互相拥抱。两人站在黄昏的海边沙滩上，男生穿着白色T恤，女生穿着浅蓝色连衣裙，海风吹动发丝，夕阳暖光从侧面照来，构图采用中景，画质高清写实、光影层次分明', { mode: 'generate' });
  assert.ok(!r.notice, '宿主已写足细节 → 不提醒');
  assert.ok(r.prompt.includes('画面约束'), '边界约束仍保留');
});

test('enhanceEditPrompt: 文生图模式（generate）→ 跳过以原图为基准的约束，保留通用约束', () => {
  const r = enhanceEditPrompt('一只金毛犬在草地上奔跑', { mode: 'generate' });
  assert.ok(r.enhanced, 'generate 模式仍增强');
  assert.ok(!r.prompt.includes('面部特征'), 'generate 无原图 → 不追加换脸约束');
  assert.ok(!r.prompt.includes('服饰'), 'generate 无原图 → 不追加服饰约束');
  assert.ok(!r.prompt.includes('人物数量与身份不变'), 'generate 无原图 → 不追加人数约束');
  assert.ok(r.prompt.includes('肢体与手指自然协调'), '保留结构约束');
  assert.ok(r.notice, 'generate 短提示词同样提醒宿主');
  assert.ok(!r.prompt.includes('细节描写：'), '不代写细节');
});

test('enhanceEditPrompt: 文生图模式——用户已写足细节时无 notice', () => {
  const r = enhanceEditPrompt('8K 超清画质，电影级光影层次，海边日落，沙滩上一位穿白色连衣裙的长发女生在奔跑，海风吹动裙摆，远景构图，画面通透、细节层次丰富', { mode: 'generate' });
  assert.ok(!r.notice, '用户已写足 50 字细节 → 无 notice');
  assert.ok(r.prompt.includes('画面约束'), '边界约束保留');
});

test('enhanceEditPrompt: 编辑模式——细节充足则无 notice，仅追加边界约束', () => {
  const r = enhanceEditPrompt('保持两人的发型、身材、服饰和人数完全不变，面部五官特征不变，表情自然生动，构图视角与光影保持原图，不做任何裁切或重绘');
  assert.ok(!r.notice, '细节充足且无姿态场景词 → 无 notice');
  assert.ok(r.enhanced, '仍追加默认边界约束（身份保持等）');
});

test('enhanceEditPrompt: notice 点名缺失维度——短指令列清已覆盖与缺失', () => {
  const r = enhanceEditPrompt('让图片中的男生和女生互相拥抱');
  assert.ok(r.notice.includes('缺少'), 'notice 点名缺失维度');
  assert.ok(r.notice.includes('场景环境'), '缺少场景 → 点名');
  assert.ok(r.notice.includes('光影氛围'), '缺少光影 → 点名');
  assert.ok(r.notice.includes('构图视角'), '缺少构图 → 点名');
  assert.ok(r.notice.includes('画质要求'), '缺少画质 → 点名');
  assert.ok(r.notice.includes('已覆盖 主体特征、动作姿态'), '已覆盖维度被列出');
});

test('enhanceEditPrompt: 字数足但维度不足 → 仍提醒（不只盯字数）', () => {
  const r = enhanceEditPrompt('让图片中的男生和女生互相拥抱，两人开心地笑着，站在画面正中间');
  assert.ok(r.notice, '仅主体+动作 2 维 → 仍提醒');
  assert.ok(r.notice.includes('缺少：场景环境、光影氛围、构图视角、画质要求'), '点明缺失四维');
});

test('enhanceEditPrompt: edit 模式提示“保持原图场景光线”路径', () => {
  const r = enhanceEditPrompt('把女生的连衣裙换成红色，她站在原地');
  assert.ok(r.notice.includes('保持原图场景光线构图'), 'edit 模式告知可保原图场景光线');
});

test('enhanceEditPrompt: generate 模式 notice 走文生图文案（无原图可依）', () => {
  const r = enhanceEditPrompt('一只金毛犬在草地上奔跑', { mode: 'generate' });
  assert.ok(r.notice.includes('文生图无原图可依'), 'generate 文案提示无原图');
  assert.ok(r.notice.includes('主体特征与状态'), '列出六维清单');
});

test('enhanceEditPrompt: 六维全覆盖且 ≥50 字 → 无 notice（generate）', () => {
  const r = enhanceEditPrompt('清晨大学校园林荫道，一位穿白色短袖衬衫和蓝色牛仔裤的男生骑着自行车缓慢前行，车轮转动，阳光从树叶缝隙洒下形成光斑，中景构图，高清写实、细节丰富', { mode: 'generate' });
  assert.ok(!r.notice, '六维齐全且足长 → 不提醒');
});

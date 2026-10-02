// prompt-enhancer.js — 图生图提示词自动增强（保护性约束）
//
// 用户图生图指令通常很简短（如"让图片中的男生和女生互相拥抱"），引擎容易
// 把人物改形、换脸、加多余元素。本模块在发送前自动追加一组"保护性约束"：
// 只锁身份特征与画质底线，不锁服装/场景（用户常要求换装换景，不能帮倒忙）。
//
// 冲突检测：用户指令里已明确要"改变某项"（如"换发型""换场景"）→ 自动跳过对应约束，
// 其余约束照常追加。约束永不新增内容、永不改写用户动作本身。
//
// 防穿模（structure）约束无关键词、永不跳过：图生图重构场景时（如站立→骑车），
// 引擎易让肢体与道具相交/嵌入。该约束锁定物理正确性而非构图，换场景时仍生效。
//
// 开关：CLI `--no-enhance` 或 config.enhanceEditPrompt=false 可整体关闭。
//
// 细节增强器（SCENE_DYNAMICS，通用化）：宿主（LLM）写图生图指令时常"偷懒"，只写
// "骑车去校园""两人坐着"而不写动态、接触物理、多人互动等细节，导致引擎出静态摆拍、
// 悬浮、穿模、脚蹬同高等问题。增强器不依赖具体场景词，按动词/元素类型触发：
//   移动类（骑/跑/走/开/飞/滑/游/跳）→ 注入"动态进行中"（不是静止摆拍）
//   接触类（坐/骑/抱/靠/扶/踩/站/牵/拿）→ 注入"接触物理"（实触、不悬空、不穿模）
//   载具类（自行车/汽车/马/后座）→ 注入"载具细节"（脚蹬高低、后座实坐、握方向盘）
//   多人互动类（两人/互相/一起）→ 注入"相对位置与接触关系"
// 注入为"忠实细化"：不新增人物与元素、不改写用户动作；用户或宿主已写出对应细节
// （skip 命中）则跳过，不重复。开关与增强器一致（--no-enhance / enhanceEditPrompt=false）。

// 复杂姿态语义展开：引擎对口语姿态词（侧坐/拥抱等）理解弱，防御禁令不够，
// 命中时把姿态展开为具体几何描述（正面+反面示例），不改写用户指令，只追加解释。
// "侧坐"等姿态词的定义随场景变化（自行车后座=双腿垂放车身一侧；椅子=双腿并拢双脚着地；
// 马背=侧鞍式），因此按场景词细化，未命中场景词时用通用展开。
const POSTURE_EXPANSIONS = [
    {
        id: 'kiss',
        match: ['亲嘴', '接吻', '亲吻', '亲一下', '亲一口', '吻', 'kiss', 'kissing', 'make out', 'making out'],
        visual: '两人面对面，头部向彼此微微倾斜、错开鼻梁，嘴唇轻柔贴合，神情沉醉自然；女生可自然搭着男生的肩膀或手臂，身体靠近不僵硬',
        text: '严格按指令执行动作：两人接吻——彼此相向、头部微微倾斜错开鼻梁，嘴唇轻柔贴合，神情自然，肢体按场景描述自然贴合；不是脸贴脸错位、不是额头相碰、不是只碰面颊、不是并肩站立',
    },
    {
        id: 'princess-hold',
        match: ['公主抱', '横抱', '抱着她走', '托抱', 'bridal carry', 'princess carry', 'carry her in arms'],
        visual: '男生弯腰将女生横抱在胸前，一手托住她的肩背、一手托住她的大腿与膝弯；女生身体横向倚靠、双臂自然环住男生脖颈或肩头，双腿自然弯垂，整体稳托贴合、重心稳固，男生步伐自然',
        text: '严格按指令执行动作：公主抱——男生一手托住女生肩背、一手托住其腿弯，女生身体横向倚靠在男生怀中、双腿自然弯垂，整体稳托不悬空、不滑落、不勒紧；不是背、不是扛、不是拦腰直抱',
    },
    {
        id: 'neck-hold',
        match: ['搂住脖子', '搂着脖子', '环抱脖子', '勾住脖子', '双臂搂住', '搂脖子', '脖子', 'arms around his neck', 'arms around her neck', 'hugging his neck', 'hugging her neck'],
        visual: '女生的双臂向上环绕、勾住男生的脖颈，身体贴近男生胸口，脸颊相依，手臂自然弯曲不僵硬，男生可顺势托住或揽住女生',
        text: '严格按指令执行动作：搂脖子——女生的双臂环绕勾住男生的脖颈，身体贴近，手臂自然弯曲不僵硬；不是搭肩、不是抱腰、不是垂手',
    },
    {
        match: ['侧坐', '侧着坐', '侧身坐', '侧边坐', 'sit sideways', 'sits sideways', 'sat sideways', 'sitting sideways', 'side-saddle', 'side saddle'],
        scenes: [
            { keys: ['自行车', '单车', '电瓶车', '电动车', '摩托车', '后座', '机车', 'bicycle', 'bike', 'motorcycle', 'scooter', 'pillion'], text: '严格按指令执行坐姿：侧身坐姿——身体侧向、双腿并拢自然垂放在车身（如后座）的同一侧，面朝侧面；不是跨坐、不是双腿分开跨在两侧、不是正坐面向车头', visual: '身体侧坐在后座上，双腿并拢垂放在车身同侧，上身自然放松，一只手可轻扶车座或前座人的腰间保持稳定' },
            { keys: ['椅子', '沙发', '凳子', '长椅', '座椅', '床边', '床沿', '窗台', '台阶', 'chair', 'sofa', 'couch', 'bench', 'seat', 'bed', 'bedside', 'windowsill', 'stairs'], text: '严格按指令执行坐姿：侧身坐姿——身体侧向、双腿并拢朝向一侧自然摆放（双脚着地或交叠）；不是正坐、不是双腿分开朝向两侧', visual: '身体侧坐在椅面/床沿上，双腿并拢朝向一侧自然摆放，双脚着地或自然交叠，背部放松' },
            { keys: ['马', '骑马', '马背', 'horse', 'horseback'], text: '严格按指令执行坐姿：侧鞍式坐姿——双腿并拢放在马背同一侧；不是跨骑、不是双腿分开跨在马背两侧', visual: '侧鞍式骑坐——双腿并拢放在马背同一侧，身体微侧，单手可轻扶缰绳或马鞍保持平衡' },
        ],
        fallback: '严格按指令执行坐姿：侧身坐姿——身体侧向、双腿并拢朝向一侧；不是跨坐、不是双腿分开、不是正坐',
        visual: '身体侧向而坐，双腿并拢自然垂放或交叠在身体一侧，朝向侧面，姿态放松自然',
    },
    {
        id: 'hug',
        match: ['拥抱', '相拥', '搂着', '搂住', '抱着', '抱住', 'hug', 'hugging', 'embrace', 'embracing'],
        visual: '两人面对面张开双臂彼此环抱，身体前倾相贴，手臂环过对方的腰或背，头可轻轻靠向对方肩侧，神情自然温暖',
        text: '严格按指令执行动作：两人相拥——手臂环绕对方身体、身体自然贴合，不是并肩站立、不是只碰肩膀',
    },
    {
        match: ['牵手', '手牵手', '拉着手', 'holding hands', 'hold hands', 'hand in hand'],
        visual: '两人靠近并肩，手指自然相扣或相握，手臂自然下垂或轻摆，步伐协调',
        text: '严格按指令执行动作：两人牵手——手指相扣或自然相握，不是并肩、不是各自垂手',
    },
    {
        id: 'piggyback',
        match: ['背着', '背起', '背在背上', '背着她', '背着他', '背人', 'piggyback', 'carrying on his back', 'carrying on her back', 'carry on back'],
        visual: '被背者趴在背者背上，双臂环抱背者的肩膀，双腿分开自然夹在背者腰侧；背者双手托住其腿弯或臀下，身体微微前倾保持平衡，步伐稳定',
        text: '严格按指令执行动作：背——被背者趴在背者背上、双臂环抱背者的肩膀或脖颈，双腿分开自然夹在背者腰侧，背者双手托住其腿弯或臀下；不是扛在肩上、不是抱在怀里、不是背靠背',
    },
    {
        id: 'fireman-carry',
        match: ['扛着', '扛起', '扛在肩上', '肩上扛', 'fireman carry', 'carry over shoulder', 'carried over the shoulder'],
        visual: '被扛者身体横搭在扛者一侧肩膀上，头部与双腿自然垂在肩膀两侧；扛者单手或双手扶稳其腰腿，步伐平稳有力',
        text: '严格按指令执行动作：扛——被扛者身体横搭在扛者一侧肩膀上（腹部或胯部搭肩），头部与双腿自然垂在肩膀两侧，扛者单手或双手扶稳其腰腿；不是背在背上、不是公主抱、不是拦腰横抱',
    },
    {
        id: 'cross-leg',
        match: ['二郎腿', '跷腿', '跷着腿', '翘腿', '翘着腿', 'ankle on knee', 'leg over leg', 'cross one leg over'],
        visual: '一条腿的脚踝或小腿搭在另一条腿的膝盖上方，两腿自然交叠，身体放松后靠，姿态从容',
        text: '严格按指令执行坐姿：跷二郎腿——一条腿的脚踝或小腿搭在另一条腿的膝盖上方，两腿自然交叠；不是双腿并拢、不是双腿分开、不是盘腿',
    },
    {
        id: 'lotus-sit',
        match: ['盘腿', '盘坐', '打坐', '莲花坐', '盘膝', 'lotus', 'cross-legged', 'cross legged', 'meditation pose'],
        visual: '双腿交叉盘起，双脚收拢在身体前方或对侧大腿下方，脊背自然挺直，坐姿安稳放松',
        text: '严格按指令执行坐姿：盘腿——双腿交叉盘起，双脚置于对侧大腿下方或膝盖附近，坐姿稳定自然；不是跷二郎腿、不是跪坐、不是双腿伸直的坐姿',
    },
    {
        id: 'squat',
        match: ['蹲下', '蹲着', '蹲在', '半蹲', 'squat', 'squatting', 'crouch', 'crouching'],
        visual: '双脚平踏地面、膝盖弯曲下蹲，臀部靠近脚跟，重心稳定落在双脚上，身体自然前倾，双手可自然搭膝或扶地',
        text: '严格按指令执行动作：蹲——双脚着地、膝盖弯曲下蹲，臀部靠近脚踝，重心稳定落在双脚上；不是站立、不是跪姿、不是席地而坐',
    },
    {
        id: 'kneel',
        match: ['跪着', '跪下', '跪在', '单膝跪', '双膝跪', 'kneel', 'kneeling', 'kneel down', 'kneel on one knee'],
        visual: '膝盖与小腿贴地，上身自然直立或微微前倾，双手可自然搭放膝上，姿态端正',
        text: '严格按指令执行动作：跪——膝盖与小腿贴地、上身自然直立或前倾，重心落在膝盖与小腿上；不是蹲、不是坐、不是站立',
    },
    {
        id: 'snuggle',
        match: ['依偎', '偎依', '靠着肩膀', '靠在怀里', '靠在他怀里', '靠在她怀里', '枕着肩', '依偎在', 'snuggle', 'snuggling', 'cuddle', 'cuddling', 'leaning on his shoulder'],
        visual: '一方依偎在另一方怀里，头轻轻靠向对方的肩或胸口，身体贴合自然，氛围亲密放松，另一方的手臂可轻揽或轻抚',
        text: '严格按指令执行动作：依偎——两人身体自然贴近，一方倚靠另一方的肩膀或怀中，头部轻轻靠拢，接触自然不僵硬；不是并肩站立、不是搂脖子',
    },
    {
        id: 'arm-around',
        match: ['勾肩搭背', '搂肩', '搭肩', '揽肩', '揽着肩', '勾着肩', 'arm around', 'arms around shoulders', 'arm over shoulder'],
        visual: '一方的手臂搭在对方一侧肩上，两人身体自然靠近，并肩而行或相对而立，关系自然亲近',
        text: '严格按指令执行动作：勾肩搭背——一方手臂搭在对方一侧肩上、两人身体自然靠近并行或对立；不是搂脖子、不是抱腰、不是牵手',
    },
    {
        id: 'back-to-back',
        match: ['背靠背', '背对背', 'back to back', 'back-to-back'],
        visual: '两人背对背相靠，背部贴合，各自面向相反方向，坐或立姿态自然放松',
        text: '严格按指令执行动作：背靠背——两人背部相贴、各自面向相反方向（坐或立均可），背部接触处贴合自然；不是背在背上、不是并肩',
    },
    {
        id: 'shoulder-ride',
        match: ['骑肩', '骑在肩上', '架在肩上', '坐在肩上', 'shoulder ride', 'riding on shoulders'],
        visual: '被骑者双腿分开骑坐在骑者双肩上，双手可轻扶骑者头顶或肩部，骑者双手扶稳其双腿，被骑者坐姿平稳不悬空、不滑落',
        text: '严格按指令执行动作：骑肩——被骑者双腿分开骑坐在骑者的双肩上，骑者双手扶住其双腿，被骑者坐稳不悬空、不滑落；不是背在背上、不是扛在肩上、不是骑脖子',
    },
];

// 场景动态细节兜底层：命中场景词时注入物理/动态细节。每条 detail 两个条件：
// - need：用户指令需包含的主题词（空数组=无条件），例如"后座实坐"只在提到后座/载人时注入
// - skip：用户/宿主已写过的细节词，命中则跳过（不重复、不冲突）
const SCENE_DYNAMICS = [
    {
        keys: ['骑', '骑行', '骑车', '跑', '奔跑', '跑步', '慢跑', '快跑', '冲刺', '走', '行走', '走路', '散步', '开', '开车', '驾车', '驾驶', '飞', '飞行', '滑', '滑行', '游', '游泳', '跳', '跳跃', '行进', '行驶', '移动', '前进', 'ride', 'riding', 'rides', 'cycle', 'cycling', 'run', 'running', 'runs', 'jog', 'jogging', 'walk', 'walking', 'walks', 'drive', 'driving', 'drives', 'fly', 'flying', 'flies', 'swim', 'swimming', 'swims', 'jump', 'jumping', 'jumps', 'move', 'moving', 'moves', 'travel', 'traveling', 'march', 'walking down'],
        details: [
            { need: [], skip: ['行驶', '动感', '动势', '动态', '运动中', '前进', '缓慢行驶', '奔跑中', '行走中', '驾驶中', '腾空', '摆拍', '静止', '停靠', '停下', '驻车', '定格', 'moving', 'dynamic', 'in motion', 'motion', 'static', 'stopped', 'frozen', 'staged'], text: '画面中的移动主体处于动态进行中（骑行时车轮转动、奔跑时脚步交替腾空、行走时步伐交替、飞行时持续前进），有明确的运动动势，不是静止、停靠、摆拍或定格' },
        ],
    },
    {
        keys: ['坐', '骑', '抱', '搂', '靠', '扶', '踩', '站', '趴', '躺', '牵', '拉', '拿', '握', '搭', '倚', 'sit', 'sitting', 'sits', 'ride', 'riding', 'hold', 'holding', 'hugs', 'hug', 'hugging', 'stand', 'standing', 'stands', 'lie', 'lying', 'lies', 'touch', 'touching', 'touches', 'lean', 'leaning', 'leans', 'rest', 'resting'],
        details: [
            { need: [], skip: ['实坐', '实触', '贴合', '不悬空', '不悬浮', '不漂浮', '不穿模', '不嵌入', '重心', '接触处', '悬垂', '着地', '落地', '踩地', '悬空', '漂浮', '嵌入', '遮挡'], text: '人物与座椅/载具/器物/他人的接触处真实贴合：重心落于支撑面，双脚按指令悬垂或着地，不悬空、不漂浮、不穿模、不嵌入，遮挡关系自然' },
        ],
    },
    {
        keys: ['自行车', '单车', '电瓶车', '电动车', '摩托车', '机车', '踩车', '骑马', '马背', '骑车', '骑行', '后座', '汽车', '轿车', '车里', '驾驶座', '开车', '驾车', '驾驶', 'bicycle', 'bike', 'bicycling', 'cycling', 'motorcycle', 'scooter', 'horse', 'horseback', 'riding', 'pillion', 'car', 'driving', 'driver seat'],
        details: [
            { need: ['自行车', '单车', '电瓶车', '电动车', '摩托车', '机车', '踩车', '骑马', '马背', '骑车', '骑行'], skip: ['脚蹬', '脚踏', '踏板', '高低', '错落', '一前一后', '前低后高', '座垫'], text: '载具细节：骑行者双脚踩在左右脚蹬上且一前一后高低错落（前侧略低、后侧略高），臀部实坐座垫' },
            { need: ['后座', '载人', '带人', '坐在', '乘', '背着'], skip: ['实坐', '重心落', '不悬空', '悬垂', '垂放', '不落地', '不踩地', '漂浮', '悬空'], text: '后座乘员臀部实坐在座垫正中、重心落于座垫，双腿并拢自然垂放车身同侧、双脚悬垂不落地不踩地，不悬空、不漂浮' },
            { need: ['汽车', '轿车', '车里', '驾驶座', '开车', '驾车', '驾驶'], skip: ['方向盘', '握盘', '视线', '驾驶中'], text: '驾驶细节：驾驶员双手握方向盘、视线向前，人物与座椅/方向盘接触真实、重心落于座椅，无悬浮无穿模' },
        ],
    },
    {
        keys: ['两人', '两个人', '双方', '彼此', '互相', '相拥', '牵手', '一起', '面对面', '并肩', 'together', 'each other', 'both', 'face to face', 'side by side', 'the two'],
        details: [
            { need: [], skip: ['相对位置', '朝向', '互动', '接触自然', '主次', '位置关系', '贴合'], text: '多人互动细节：人物之间的相对位置、朝向与身体接触关系自然协调，接触处（拥抱/牵手/扶持等）贴合无穿模、无重叠错位、无悬浮，画面主次分明' },
        ],
    },
    {
        keys: ['游泳', '戏水', '玩水', '跳水', '潜水', '泡温泉', '漂浮在水', '水里', '水中', '海边', '泳池', '入水', 'swim', 'swimming', 'dive', 'diving', 'pool', 'in the water', 'beach', 'float', 'floating'],
        details: [
            { need: [], skip: ['浮力', '水花', '湿润', '湿身', '打湿', '湿发', '涟漪', '没入'], text: '水中细节——身体与水的接触自然：受浮力作用部分身体没入水中或漂浮于水面，水花、涟漪与湿发自然，不悬空僵硬、不穿模' },
        ],
    },
    {
        keys: ['跳舞', '舞蹈', '舞动', '起舞', '芭蕾', '转圈', '旋转', '舞步', 'dance', 'dancing', 'ballet', 'pirouette', 'twirl', 'twirling'],
        details: [
            { need: [], skip: ['舞姿', '重心', '旋转中', '动势', '舒展'], text: '舞蹈细节——舞者重心稳定、动作舒展连贯，肢体与节奏协调，裙摆/衣摆随动作自然摆动，不僵硬定格' },
        ],
    },
    {
        keys: ['滑雪', '滑冰', '溜冰', '滑雪板', '雪板', '冰刀', '雪地', '冰面', 'ski', 'skiing', 'skate', 'skating', 'snowboard', 'snow', 'ice', 'ice rink'],
        details: [
            { need: [], skip: ['重心', '雪痕', '冰痕', '动势', '滑行中'], text: '雪/冰上运动细节——身体重心压低随地形起伏，雪板/冰刀与雪面或冰面贴合，身后有自然滑痕，动态连贯不静止' },
        ],
    },
    {
        keys: ['打球', '踢球', '投篮', '扣球', '发球', '传球', '运球', '击球', '接球', '网球', '篮球', '足球', '羽毛球', '乒乓球', '排球', '棒球', 'play ball', 'kicking', 'kicks', 'shoot', 'shooting', 'shoots', 'serve', 'serves', 'pass', 'passing', 'passes', 'dribble', 'dribbling', 'dribbles', 'hit', 'hitting', 'hits', 'catch', 'catches', 'tennis', 'basketball', 'soccer', 'football', 'badminton', 'baseball'],
        details: [
            { need: [], skip: ['球的位置', '击球动作', '视线', '球速', '动势'], text: '球类运动细节——球与身体/器械（手、脚、拍、棒）的接触点准确，动作与球的轨迹方向一致，视线跟随球，动态自然不僵' },
        ],
    },
    {
        keys: ['攀岩', '攀爬', '爬山', '爬树', '爬上', '攀登', '岩壁', 'climb', 'climbing', 'rock climbing', 'scramble'],
        details: [
            { need: [], skip: ['支点', '手脚', '重心', '悬空', '着力'], text: '攀爬细节——手脚在支点（岩点/枝干/台阶）上真实着力，重心贴向攀爬面，身体舒展不悬空、不僵硬' },
        ],
    },
    {
        keys: ['秋千', '荡秋千', '荡', 'swing', 'swinging'],
        details: [
            { need: [], skip: ['摆动', '抓握', '重心', '绳索', '链条'], text: '秋千细节——双手抓握绳索/链条、身体随摆动自然起伏，重心随荡幅移动，绳索有真实张力，不悬空僵硬' },
        ],
    },
    {
        keys: ['弹琴', '弹钢琴', '弹吉他', '拉小提琴', '吹奏', '演奏', '拨弦', '按弦', '架子鼓', '敲鼓', 'play piano', 'playing piano', 'play guitar', 'playing guitar', 'violin', 'flute', 'perform', 'performing', 'drum', 'drumming'],
        details: [
            { need: [], skip: ['手型', '指法', '与乐器', '贴合', '琴键', '琴弦'], text: '演奏细节——手部与乐器接触真实（手指按弦/按键、持弓/持拨片），身体姿态与乐器协调自然，不悬空、不穿模' },
        ],
    },
    {
        keys: ['睡觉', '睡着', '躺着', '躺下', '躺椅', '床上', '午睡', '侧卧', '仰卧', '平躺', 'sleep', 'sleeping', 'lie down', 'lying down', 'lying on', 'bed', 'nap', 'reclining'],
        details: [
            { need: [], skip: ['贴合', '枕', '被子', '盖', '放松', '不悬空', '舒展'], text: '躺卧细节——身体与床面/枕/被的接触处贴合自然，姿态放松舒展，四肢自然摆放，不僵硬、不悬空' },
        ],
    },
];

const CONSTRAINT_GROUPS = [
    {
        id: 'face',
        keywords: ['换脸', '变脸', '换成另一个人', '换一张脸', '改变人脸', '替换人脸'],
        text: '严格锁定人物身份：面部特征、五官形状、脸型、肤色、眉眼鼻口与原图完全一致，不得换脸、美颜、卡通化或重绘面容',
    },
    {
        id: 'hair',
        keywords: ['换发型', '改发型', '换个发型', '烫发', '染发', '剪发', '剪短', '留长', '扎起来', '披下来', '梳起来', '改变发型', '发型可以改变', '发型改变', '换个造型', '变个发型', '发型变化', '换一个发型'],
        text: '发型严格锁定原图：发型、发色、发量、刘海、纹理与长度与原图完全一致，不得更换造型、不得改变长短疏密、不得添加原图没有的发型特征（如纹理烫、发胶造型、新刘海、更蓬松等）；即使指令中出现发型相关描述词，发型仍一律以原图为准，描述仅供参考、不得执行改动',
    },
    {
        id: 'body',
        keywords: ['变瘦', '变胖', '瘦一点', '胖一点', '增肌', '改变身材', '换身材', '变苗条', '变壮', '偏瘦', '偏胖', '减脂', '增重', '减重', '发福', '变肥'],
        text: '保持人物身材比例不变',
        dynamic: '严格保持画面中未被指令要求改动的其他人物（以及被指定改动的对象除指定变化外的其他部位）身材比例、体型完全不变；仅按指令调整指定的身材变化，不得连带改变其他人物或部位',
    },
    {
        id: 'count',
        keywords: ['加一个人', '增加一个人', '再加一个人', '多一个人', '少一个人', '删掉人物', '删除人物', '去掉人物', '移除人物'],
        text: '保持画面人物数量与身份不变，不得新增、删除或遮挡人物',
    },
    {
        id: 'pose',
        keywords: [],
        text: '肢体与手指自然协调，不得出现肢体畸变、多余肢体、手指畸形或五官错位',
    },
    {
        id: 'expression',
        keywords: [],
        text: '人物表情自然生动、五官协调放松，不得僵硬、呆滞、木讷、面无表情或表情扭曲',
    },
    {
        id: 'scene',
        keywords: ['换场景', '新场景', '换个场景', '换成', '改为', '改成', '场景为', '场景是', '背景为', '背景是', '重新生成'],
        text: '保持原图的构图、视角、光影与整体风格',
    },
    {
        id: 'structure',
        keywords: [],
        text: '人物的身体比例、姿态与空间透视正确，肢体与道具（如自行车、车辆、家具、器物）的接触处合理遮挡、不得穿模、不得嵌入或重叠物体，四肢五官不畸变、不悬浮错位',
    },
    {
        id: 'posture',
        keywords: [],
        text: '严格遵循用户指定的坐姿、站姿与动作（如侧坐、拥抱、牵手、行走），不得用其他常见姿势替换（例如把"侧坐"画成跨坐、双腿分开，把"牵手"画成并肩）',
    },
    {
        id: 'hair-detail',
        keywords: [],
        text: '头发顺滑自然、发丝清晰细腻，不得炸毛、毛躁、飞丝、发丝粘连或糊成一团',
    },
    {
        id: 'cloth',
        keywords: ['换衣服', '换装', '换件', '换上', '改穿', '脱掉', '脱去', '换成', '换裙子', '换衬衫', '换裤子', '换外套', '穿件', '穿一条', '替换成', '校园风', '校服', '换衣', '穿衣'],
        text: '严格保持人物原有服饰、衣着与穿戴不变（除非指令明确要求更换服装）',
    },
    {
        id: 'watermark',
        keywords: [],
        text: '不得在画面中添加文字、水印或 logo',
    },
];

// ---- 短提示词检测（职责边界）----
// 提示词「怎么写好」是宿主（LLM）的工作：主体/动作/环境/光影/构图/画质等细节描写
// 由宿主按写作指南撰写，本插件**绝不代写**画面细节。插件只做两件事：
//   1. 追加保护性边界约束（防换脸/防畸变/防穿模/姿态语义澄清等，见 CONSTRAINT_GROUPS）；
//   2. 检测宿主提示词「字数不足 100 字 或 六维覆盖 < 3 维」时，返回 notice 提醒宿主
//      按写作指南补细节，并点名**缺失维度**；提醒文字不写入 prompt、不代写内容。
const PROMPT_LENGTH_FLOOR = 100;
const GUIDE_DIM_MIN = 3;

// 提示词写作指南六维检测词表（中英文代表词；只用于“指导宿主”，不用于改写）
const GUIDE_DIMS = [
    {
        id: 'subject',
        label: '主体特征',
        words: ['女生', '男生', '女孩', '男孩', '女人', '男人', '人物', '情侣', '小孩', '老人', '学生', '模特', '她', '他', '狗', '猫', '犬', '鸟', '马', '宠物', '穿', '戴', '长发', '短发', '发色', '肤色', '体型', '身材', 't恤', '衬衫', '连衣裙', '裙', '裤', '帽', '眼镜', '胡子', '棉麻', '牛仔', '丝绸', '雪纺', '亚克力', '皮革', '西装', '毛衣', 'woman', 'man', 'girl', 'boy', 'person', 'people', 'couple', 'child', 'student', 'dog', 'cat', 'bird', 'horse', 'pet', 'wearing', 'dress', 'shirt', 'hair'],
    },
    {
        id: 'action',
        label: '动作姿态',
        words: ['站', '坐', '躺', '跑', '走', '骑', '抱', '牵', '搂', '亲', '吻', '跳', '蹲', '靠', '拿', '举', '梳', '看', '笑', '挥手', '散步', '奔跑', '跳舞', '唱歌', '玩', '握', '扶', '踩', '依偎', '拥抱', '接吻', '骑行', '开车', '飞翔', '游泳', '姿势', 'pose', 'walk', 'run', 'sit', 'stand', 'ride', 'hug', 'kiss', 'dance', 'jump', 'hold', 'play', 'swim', 'fly', 'wave'],
    },
    {
        id: 'scene',
        label: '场景环境',
        words: ['海边', '沙滩', '海岸', '校园', '学校', '公园', '草地', '树林', '森林', '街道', '城市', '马路', '广场', '卧室', '客厅', '房间', '室内', '户外', '山里', '湖边', '河边', '阳台', '厨房', '办公室', '教室', '操场', '图书馆', '背景', '台面', '桌面', '路面', 'beach', 'park', 'campus', 'school', 'street', 'room', 'indoor', 'outdoor', 'forest', 'mountain', 'lake', 'river', 'garden', 'field'],
    },
    {
        id: 'light',
        label: '光影氛围',
        words: ['光影', '光线', '阳光', '灯光', '晨光', '夕阳', '黄昏', '逆光', '柔和', '明亮', '暖色', '冷调', '氛围', '清晨', '傍晚', '夜晚', '白天', '晴天', '阴天', '光照', '柔光', '硬光', '侧光', '顶光', '漫射', '暖金', '冷白', '霓虹', '色温', 'light', 'sun', 'sunlight', 'glow', 'shadow', 'warm', 'bright', 'mood', 'morning', 'evening', 'night', 'sunset'],
    },
    {
        id: 'composition',
        label: '构图视角',
        words: ['构图', '视角', '镜头', '景别', '中景', '近景', '远景', '特写', '全景', '俯视', '仰视', '平视', '正面', '侧面', '机位', '背景虚化', '景深', '虚化', '居中', '三分', '留白', '低角度', 'composition', 'angle', 'view', 'close-up', 'closeup', 'wide shot', 'medium shot', 'perspective'],
    },
    {
        id: 'quality',
        label: '画质要求',
        words: ['画质', '高清', '超清', '8k', '4k', '2k', '写实', '真实', '细节', '清晰', '细腻', '质感', '分辨率', '逼真', 'quality', 'hd', 'ultra', 'realistic', 'detailed', 'crisp', 'sharp', 'resolution'],
    },
];

function countGuideDims(text) {
    const t = text.toLowerCase();
    const hit = new Set();
    for (const dim of GUIDE_DIMS) {
        for (const word of dim.words) {
            const found = /^[a-z]/i.test(word)
                ? new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`, 'i').test(t)
                : t.includes(word);
            if (found) { hit.add(dim.id); break; }
        }
    }
    return hit;
}

function buildGuideNotice(len, dims, mode) {
    const covered = [...dims].map((id) => GUIDE_DIMS.find((d) => d.id === id)?.label).filter(Boolean);
    const missing = GUIDE_DIMS.filter((d) => !dims.has(d.id)).map((d) => d.label);
    const missText = missing.length > 0 ? `，缺少：${missing.join('、')}` : '';
    if (mode === 'generate') {
        return `提示词仅 ${len} 字${missText}。文生图无原图可依，请按提示词写作指南补全六维：主体特征与状态、动作姿态、场景环境、光影氛围、构图视角、画质要求（建议 ≥100 字，逐项写具体）。本插件只添加保护性边界约束，不会代写画面细节。`;
    }
    const keepScene = missing.includes('场景环境') || missing.includes('光影氛围') || missing.includes('构图视角');
    return `提示词仅 ${len} 字${missText}。图生图请先读图锁定身份（面部/发型/身材），再按提示词写作指南补充细节：已覆盖 ${covered.join('、') || '（无）'}${missing.length > 0 ? `，补全缺失维度（${missing.join('、')}）` : ''}${keepScene ? '；若新场景不变、原图光影构图保持不变，可写明“保持原图场景光线构图”' : ''}（建议 ≥100 字，逐项写具体）。本插件只添加保护性边界约束，不会代写画面细节。`;
}

// 文生图（generate）模式：没有原图作基准，跳过「以原图为基准」的约束组
// （换脸/发型/身材/人物数量/服饰/原图构图光影 等），保留通用结构/表情/发丝/水印约束。
const GENERATE_MODE_SKIP = new Set(['face', 'hair', 'body', 'count', 'cloth', 'scene']);

/**
 * 增强图生图指令：追加保护性约束。
 * @param {string} prompt 用户原始指令
 * @param {{enabled?: boolean, mode?: 'edit' | 'generate'}} options
 *   enabled=false 时原样返回；mode='generate'（文生图）时跳过「以原图为基准」的约束组
 * @returns {{ prompt: string, enhanced: boolean, skipped: string[] }}
 */
export function enhanceEditPrompt(prompt, { enabled = true, mode = 'edit' } = {}) {
    const original = typeof prompt === 'string' ? prompt.trim() : '';
    if (!enabled || original === '') {
        return { prompt: original, enhanced: false, skipped: [] };
    }
    const skipped = [];
    const active = [];
    const t = original.toLowerCase();
    // 英文词按单词边界匹配（'visit' 不得命中 'sit'、'with' 不得命中 'hit'），中文词保持子串匹配
    const containsWord = (text, word) => /^[a-z]/i.test(word)
        ? new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
        : text.includes(word.toLowerCase());
    for (const group of CONSTRAINT_GROUPS) {
        // 文生图模式：无原图基准，跳过换脸/发型/身材/人数/服饰/原图构图光影等约束
        if (mode === 'generate' && GENERATE_MODE_SKIP.has(group.id)) continue;
        const hit = group.keywords.some((keyword) => containsWord(t, keyword));
        if (group.id === 'posture') {
            // 多姿态组合：收集所有命中的姿态条目（公主抱+搂脖子+亲嘴 等），逐条展开拼接
            const expansions = POSTURE_EXPANSIONS.filter((entry) => entry.match.some((word) => containsWord(t, word)));
            // 具体肢体条目（公主抱/搂脖子）已精确描述手臂与托抱 → 取代通用拥抱，避免肢体描述冲突
            const hasConcreteHold = expansions.some((e) => e.id === 'princess-hold' || e.id === 'neck-hold');
            const poseList = hasConcreteHold ? expansions.filter((e) => e.id !== 'hug') : expansions;
            let text = group.text;
            const visuals = [];
            if (poseList.length > 0) {
                text = poseList.map((exp) => {
                    const scene = exp.scenes
                        ? exp.scenes.find((sc) => sc.keys.some((k) => containsWord(t, k)))
                        : null;
                    if (scene) {
                        if (scene.visual) visuals.push(scene.visual);
                        return scene.text;
                    }
                    if (exp.visual) visuals.push(exp.visual);
                    return exp.fallback || exp.text || group.text;
                }).join(' ');
            }
            active.push({ ...group, text, visuals: visuals.filter(Boolean) });
        } else if (hit && group.dynamic) {
            active.push({ ...group, text: group.dynamic });
        } else if (hit) {
            skipped.push(group.id);
        } else {
            active.push(group);
        }
    }
    // 场景动态细节兜底：命中场景词且用户未写细节时注入（忠实细化，不新增元素）
    const details = [];
    for (const scene of SCENE_DYNAMICS) {
        if (!scene.keys.some((k) => containsWord(t, k))) continue;
        for (const d of scene.details) {
            if (d.need.length > 0 && !d.need.some((k) => containsWord(t, k))) continue;
            if (d.skip.some((k) => containsWord(t, k))) continue;
            details.push(d.text);
        }
    }
    if (active.length === 0 && details.length === 0) {
        // 无任何边界约束可加时：不改写 prompt，但提示词不足仍给宿主提醒
        const originalLen = original.replace(/\s/g, '').length;
        const dims = countGuideDims(original);
        const notice = originalLen < PROMPT_LENGTH_FLOOR || dims.size < GUIDE_DIM_MIN
            ? buildGuideNotice(originalLen, dims, mode)
            : '';
        return { prompt: original, enhanced: false, skipped, ...(notice ? { notice } : {}) };
    }
    const suffix = `画面约束：${active.map((group, i) => `${i + 1}.${group.text}`).join('；')}。`;
    const poseVisuals = active.flatMap((g) => g.visuals || []);
    const poseText = poseVisuals.length > 0
        ? `姿态细节：${poseVisuals.join(' ')}${poseVisuals.length > 1 ? ' 多姿态协调：多个动作同时发生时，保持各动作的空间关系与肢体协调，接触部位贴合、互不遮挡、互不穿模，整体构图自然。' : ''}`
        : '';
    const dynamicsText = details.length > 0 ? `场景动态细节：${details.join('；')}。` : '';
    // 短提示词检测：原文（去空白）不足 100 字或六维覆盖不足 3 维 → 提醒宿主补细节
    // （不代写、不写入 prompt），并点名缺失维度
    const originalLen = original.replace(/\s/g, '').length;
    const dims = countGuideDims(original);
    const notice = originalLen < PROMPT_LENGTH_FLOOR || dims.size < GUIDE_DIM_MIN
        ? buildGuideNotice(originalLen, dims, mode)
        : '';
    return {
        prompt: `${original}。${suffix}${poseText}${dynamicsText}`,
        enhanced: true,
        skipped,
        ...(notice ? { notice } : {}),
    };
}

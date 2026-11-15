// jisu v2.60.1 — 台灣門牌地址正規化、TWD97 TM2 轉 WGS84 與分片查詢純函式模組
// 瀏覽器（<script src="geocode.js">）掛在 self.Geocode，Node 用 module.exports，Worker 亦共用相同邏輯。
(function (root) {
  "use strict";

  const COUNTY_DISTS = {"臺北市": ["松山區", "信義區", "大安區", "中山區", "中正區", "大同區", "萬華區", "文山區", "南港區", "內湖區", "士林區", "北投區"], "臺中市": ["中區", "東區", "南區", "西區", "北區", "西屯區", "南屯區", "北屯區", "豐原區", "東勢區", "大甲區", "清水區", "沙鹿區", "梧棲區", "后里區", "神岡區", "潭子區", "大雅區", "新社區", "石岡區", "外埔區", "大安區", "烏日區", "大肚區", "龍井區", "霧峰區", "太平區", "大里區", "和平區"], "基隆市": ["中正區", "七堵區", "暖暖區", "仁愛區", "中山區", "安樂區", "信義區"], "臺南市": ["新營區", "鹽水區", "白河區", "柳營區", "後壁區", "東山區", "麻豆區", "下營區", "六甲區", "官田區", "大內區", "佳里區", "學甲區", "西港區", "七股區", "將軍區", "北門區", "新化區", "善化區", "新市區", "安定區", "山上區", "玉井區", "楠西區", "南化區", "左鎮區", "仁德區", "歸仁區", "關廟區", "龍崎區", "永康區", "東區", "南區", "北區", "安南區", "安平區", "中西區"], "高雄市": ["鹽埕區", "鼓山區", "左營區", "楠梓區", "三民區", "新興區", "前金區", "苓雅區", "前鎮區", "旗津區", "小港區", "鳳山區", "林園區", "大寮區", "大樹區", "大社區", "仁武區", "鳥松區", "岡山區", "橋頭區", "燕巢區", "田寮區", "阿蓮區", "路竹區", "湖內區", "茄萣區", "永安區", "彌陀區", "梓官區", "旗山區", "美濃區", "六龜區", "甲仙區", "杉林區", "內門區", "茂林區", "桃源區", "那瑪夏區"], "新北市": ["板橋區", "三重區", "中和區", "永和區", "新莊區", "新店區", "樹林區", "鶯歌區", "三峽區", "淡水區", "汐止區", "瑞芳區", "土城區", "蘆洲區", "五股區", "泰山區", "林口區", "深坑區", "石碇區", "坪林區", "三芝區", "石門區", "八里區", "平溪區", "雙溪區", "貢寮區", "金山區", "萬里區", "烏來區"], "宜蘭縣": ["宜蘭市", "羅東鎮", "蘇澳鎮", "頭城鎮", "礁溪鄉", "壯圍鄉", "員山鄉", "冬山鄉", "五結鄉", "三星鄉", "大同鄉", "南澳鄉"], "桃園市": ["桃園區", "中壢區", "大溪區", "楊梅區", "蘆竹區", "大園區", "龜山區", "八德區", "龍潭區", "平鎮區", "新屋區", "觀音區", "復興區"], "嘉義市": ["東區", "西區"], "新竹縣": ["竹北市", "竹東鎮", "新埔鎮", "關西鎮", "湖口鄉", "新豐鄉", "芎林鄉", "橫山鄉", "北埔鄉", "寶山鄉", "峨眉鄉", "尖石鄉", "五峰鄉"], "苗栗縣": ["苗栗市", "苑裡鎮", "通霄鎮", "竹南鎮", "頭份市", "後龍鎮", "卓蘭鎮", "大湖鄉", "公館鄉", "銅鑼鄉", "南庄鄉", "頭屋鄉", "三義鄉", "西湖鄉", "造橋鄉", "三灣鄉", "獅潭鄉", "泰安鄉"], "南投縣": ["南投市", "埔里鎮", "草屯鎮", "竹山鎮", "集集鎮", "名間鄉", "鹿谷鄉", "中寮鄉", "魚池鄉", "國姓鄉", "水里鄉", "信義鄉", "仁愛鄉"], "彰化縣": ["彰化市", "鹿港鎮", "和美鎮", "線西鄉", "伸港鄉", "福興鄉", "秀水鄉", "花壇鄉", "芬園鄉", "員林市", "溪湖鎮", "田中鎮", "大村鄉", "埔鹽鄉", "埔心鄉", "永靖鄉", "社頭鄉", "二水鄉", "北斗鎮", "二林鎮", "田尾鄉", "埤頭鄉", "芳苑鄉", "大城鄉", "竹塘鄉", "溪州鄉"], "新竹市": ["東區", "北區", "香山區"], "雲林縣": ["斗六市", "斗南鎮", "虎尾鎮", "西螺鎮", "土庫鎮", "北港鎮", "古坑鄉", "大埤鄉", "莿桐鄉", "林內鄉", "二崙鄉", "崙背鄉", "麥寮鄉", "東勢鄉", "褒忠鄉", "臺西鄉", "元長鄉", "四湖鄉", "口湖鄉", "水林鄉"], "嘉義縣": ["太保市", "朴子市", "布袋鎮", "大林鎮", "民雄鄉", "溪口鄉", "新港鄉", "六腳鄉", "東石鄉", "義竹鄉", "鹿草鄉", "水上鄉", "中埔鄉", "竹崎鄉", "梅山鄉", "番路鄉", "大埔鄉", "阿里山鄉"], "屏東縣": ["屏東市", "潮州鎮", "東港鎮", "恆春鎮", "萬丹鄉", "長治鄉", "麟洛鄉", "九如鄉", "里港鄉", "鹽埔鄉", "高樹鄉", "萬巒鄉", "內埔鄉", "竹田鄉", "新埤鄉", "枋寮鄉", "新園鄉", "崁頂鄉", "林邊鄉", "南州鄉", "佳冬鄉", "琉球鄉", "車城鄉", "滿州鄉", "枋山鄉", "三地門鄉", "霧臺鄉", "瑪家鄉", "泰武鄉", "來義鄉", "春日鄉", "獅子鄉", "牡丹鄉"], "花蓮縣": ["花蓮市", "鳳林鎮", "玉里鎮", "新城鄉", "吉安鄉", "壽豐鄉", "光復鄉", "豐濱鄉", "瑞穗鄉", "富里鄉", "秀林鄉", "萬榮鄉", "卓溪鄉"], "臺東縣": ["臺東市", "成功鎮", "關山鎮", "卑南鄉", "鹿野鄉", "池上鄉", "東河鄉", "長濱鄉", "太麻里鄉", "大武鄉", "綠島鄉", "海端鄉", "延平鄉", "金峰鄉", "達仁鄉", "蘭嶼鄉"], "金門縣": ["金城鎮", "金沙鎮", "金湖鎮", "金寧鄉", "烈嶼鄉", "烏坵鄉"], "澎湖縣": ["馬公市", "湖西鄉", "白沙鄉", "西嶼鄉", "望安鄉", "七美鄉"], "連江縣": ["南竿鄉", "北竿鄉", "莒光鄉", "東引鄉"]};

  // 官方目前無免費開放門牌資料的縣市（嘉義縣於本單 curl 成功下載並納入建庫，此處保留預設 4 縣市；Worker 亦支援動態清單）
  const MISSING_COUNTIES = new Set(["南投縣", "嘉義市", "宜蘭縣", "連江縣"]);

  const COUNTY_ALIASES = {
    "台北市": "臺北市", "台北": "臺北市", "臺北": "臺北市",
    "新北市": "新北市", "新北": "新北市",
    "基隆市": "基隆市", "基隆": "基隆市",
    "桃園市": "桃園市", "桃園": "桃園市",
    "新竹市": "新竹市",
    "新竹縣": "新竹縣",
    "苗栗縣": "苗栗縣", "苗栗": "苗栗縣",
    "台中市": "臺中市", "台中": "臺中市", "臺中": "臺中市",
    "彰化縣": "彰化縣", "彰化": "彰化縣",
    "南投縣": "南投縣", "南投": "南投縣",
    "雲林縣": "雲林縣", "雲林": "雲林縣",
    "嘉義市": "嘉義市",
    "嘉義縣": "嘉義縣",
    "台南市": "臺南市", "台南": "臺南市", "臺南": "臺南市",
    "高雄市": "高雄市", "高雄": "高雄市",
    "屏東縣": "屏東縣", "屏東": "屏東縣",
    "宜蘭縣": "宜蘭縣", "宜蘭": "宜蘭縣",
    "花蓮縣": "花蓮縣", "花蓮": "花蓮縣",
    "台東縣": "臺東縣", "台東": "臺東縣", "臺東": "臺東縣",
    "澎湖縣": "澎湖縣", "澎湖": "澎湖縣",
    "金門縣": "金門縣", "金門": "金門縣",
    "連江縣": "連江縣", "馬祖": "連江縣", "連江": "連江縣"
  };

  // 建立唯一鄉鎮市區反查表（僅在不重名的情況下允許省略縣市自動推斷）
  const DIST_TO_COUNTIES = {};
  for (const [county, dists] of Object.entries(COUNTY_DISTS)) {
    for (const d of dists) {
      if (!DIST_TO_COUNTIES[d]) DIST_TO_COUNTIES[d] = [];
      DIST_TO_COUNTIES[d].push(county);
    }
  }
  const ALL_COUNTIES = Object.keys(COUNTY_DISTS).concat(Object.keys(COUNTY_ALIASES))
    .sort((a, b) => b.length - a.length);

  // 中文數字與阿拉伯數字互轉（只用於「段」，絕不誤轉路名中的「光明九路」）
  const ZH_DIGIT = { "零": 0, "〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  const ZH_NUM_STR = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

  function intToZhSec(n) {
    n = Math.trunc(Number(n));
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n < 10) return ZH_NUM_STR[n];
    if (n === 10) return "十";
    if (n < 20) return "十" + ZH_NUM_STR[n % 10];
    if (n < 100) {
      const t = Math.floor(n / 10), u = n % 10;
      return ZH_NUM_STR[t] + "十" + (u ? ZH_NUM_STR[u] : "");
    }
    return String(n);
  }

  function toHalfWidth(s) {
    if (s == null) return "";
    let out = "";
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c === 0x3000) out += " ";
      else if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
      else out += str[i];
    }
    return out.replace(/[\s\u00A0]+/g, "").replace(/[－—–−]/g, "-");
  }

  function normCounty(s) {
    const t = toHalfWidth(s);
    return COUNTY_ALIASES[t] || t;
  }

  // 台／臺：只對臺灣縣市與常見地名專根轉臺，保留「台糖一街」「台電」「台鐵」等專名
  function normTaiGeo(s) {
    return s
      .replace(/台(?=[北中南東西灣澎金])/g, "臺")
      .replace(/^[台臺]彎/, "臺灣");
  }

  function normRoad(s) {
    let t = toHalfWidth(s);
    if (!t) return "";
    t = normTaiGeo(t);
    // 僅轉換「<數字>段」為「<國字>段」，不碰「光明九路」「四維三路」「三民路」等路名國字
    t = t.replace(/(\d+)段/g, (_, num) => {
      const zh = intToZhSec(num);
      return zh ? zh + "段" : num + "段";
    });
    return t.replace(/\//g, "_");
  }

  function normLaneAlley(laneRaw, alleyRaw) {
    const normPart = (p, suffix) => {
      let t = toHalfWidth(p);
      if (!t) return "";
      t = normTaiGeo(t);
      t = t.replace(/[Gg]-/g, "巷").replace(/[Hh]-/g, "弄");
      t = t.replace(/^0+(\d)/, "$1");
      if (/^\d+$/.test(t)) t += suffix;
      return t;
    };
    const lane = normPart(laneRaw, "巷");
    const alley = normPart(alleyRaw, "弄");
    return { lane, alley, laneAlley: lane + alley };
  }

  // 解析門牌號碼：
  // 1) 去樓層與樓層之N（如「7號二樓之1」->「7」，「27之1號地下一層之1」->「27-1」）
  // 2) 處理新竹縣「D-/G-/H-/I-」household 標記（「139I-」->「139號」，「36G-1I-2樓」->「1」）
  // 3) 統一「175之2號」「28號之1」「82號之1」「2之3之2號」「138之1附1號」
  function normNumber(raw) {
    let t = toHalfWidth(raw);
    if (!t) return { numKey: "", mainNum: null, parity: null, hasPrefix: "" };

    // 處理新竹縣前綴與「I-」->「號」
    t = t.replace(/^.*(?:[DdGgHh]-|[鄰巷弄])/, "");
    t = t.replace(/[Ii]-?/g, "號");

    // 先處理「樓層／地下」與緊接在樓層後的「之N／附N」，避免與地面一樓「28號之1」混淆
    t = t.replace(/(?:地下[一二三四五六七八九十百零〇0-9]*[層室]?|(?:[一二三四五六七八九十百零〇0-9]+樓|\d+F|B\d+))(?:[之\-~～附].*)?$/i, "");
    // 處理無數字的樓層寫法如「28號地下室」「28號夾層」
    t = t.replace(/(?:地下室|地下層|夾層|頂樓|屋頂|樓頂)(?:[之\-~～附].*)?$/g, "");

    // 若含有明顯前綴「臨」或「特」保留標記同時解析數字
    let prefix = "";
    const mPre = /^([臨特])/.exec(t);
    if (mPre) {
      prefix = mPre[1];
      t = t.slice(1);
    }

    // 「之」與「-」統一，「號」移除，「附」轉成 canonical `f`（方便辨識且可退回主附號）
    t = t.replace(/號/g, "");
    t = t.replace(/[之\-~～]+/g, "-");
    t = t.replace(/附/g, "f");
    // 清理多餘分隔與數字前導零
    t = t.replace(/^-+|-+$/g, "");
    t = t.replace(/(^|[-f])0+(\d)/g, "$1$2");

    if (!t || !/\d/.test(t)) return { numKey: "", mainNum: null, parity: null, hasPrefix: prefix };
    const mMain = /^(\d+)/.exec(t);
    const mainNum = mMain ? parseInt(mMain[1], 10) : null;
    const parity = mainNum != null && Number.isFinite(mainNum) ? (mainNum % 2 === 1 ? "odd" : "even") : null;
    const numKey = prefix + t;
    return { numKey, mainNum, parity, hasPrefix: prefix };
  }

  // 解析完整路段＋巷＋弄＋號（共用給新竹市「地址」欄與使用者搜尋字串）
  function parseRoadLaneNum(restStr) {
    let s = toHalfWidth(restStr);
    if (!s) return { neighbor: "", village: "", road: "", lane: "", alley: "", laneAlley: "", numRaw: "", numKey: "", mainNum: null, parity: null };

    // 新竹縣 D-/G-/H-/I- 標記轉標準漢字後綴
    s = s.replace(/[Dd]-/g, "鄰").replace(/[Gg]-/g, "巷").replace(/[Hh]-/g, "弄").replace(/[Ii]-/g, "號");

    // 抽出並去掉「鄰」（002鄰 == 2鄰）
    let neighbor = "";
    s = s.replace(/(\d+)鄰/g, (_, n) => {
      if (!neighbor) neighbor = String(parseInt(n, 10));
      return "";
    });

    // 村／里可省略：只有當移除開頭「XX村／里」後還剩有效街路／地區名時才剝除
    let village = "";
    const mVil = /^([\u4e00-\u9fff]{1,5}?[村里])(?![路街道巷弄段村里])(.*)$/.exec(s);
    if (mVil && mVil[2] && !/^[臨特]?\d/.test(mVil[2])) {
      village = mVil[1];
      s = mVil[2];
    }

    // Step A: 分離尾端門牌號
    let prefix = s, numRaw = "";
    const lastMarkerIdx = Math.max(
      s.lastIndexOf("弄"),
      s.lastIndexOf("巷"),
      s.lastIndexOf("段"),
      s.lastIndexOf("路"),
      s.lastIndexOf("街"),
      s.lastIndexOf("大道") >= 0 ? s.lastIndexOf("大道") + 1 : -1
    );
    if (lastMarkerIdx >= 0) {
      const tail = s.slice(lastMarkerIdx + 1);
      if (tail && /^([臨特]?\d|地下)/.test(tail)) {
        prefix = s.slice(0, lastMarkerIdx + 1);
        numRaw = tail;
      }
    }
    if (!numRaw) {
      // 無路／街／段／巷／弄或段後含聚落／院區（如「三塊厝82之1號」「自強新村57之1號三樓」「光復路二段清大西院41號」）
      const mRural = /^(.+?)([臨特]?\d+(?:(?:[之\-~～]\d+|附\d+|號|\(臨\)|[Ii]-).*|\.[0-9]+)*)$/.exec(s);
      if (mRural && !/^\d+$/.test(mRural[1])) {
        prefix = mRural[1];
        numRaw = mRural[2];
      }
    }

    // Step B: 從 prefix 尾端分離「弄」（不跨越路／街／段／巷邊界）
    let alleyRaw = "";
    const mAlley = /^(.+(?:巷|路|街|大道|段))([^\s路街道段巷]+弄)$/.exec(prefix)
      || /^(.+?)(\d+弄|[一二三四五六七八九十]{1,3}弄)$/.exec(prefix);
    if (mAlley) {
      prefix = mAlley[1];
      alleyRaw = mAlley[2];
    }

    // Step C: 從 prefix 尾端分離「巷」（含數字巷如「301巷」及專名巷如「正隆巷」）
    let laneRaw = "";
    if (prefix.endsWith("巷")) {
      const mRoadLane = /^(.+(?:路|街|大道|[一二三四五六七八九十0-9]+段))([^\s路街道段巷]+巷)$/.exec(prefix);
      if (mRoadLane) {
        prefix = mRoadLane[1];
        laneRaw = mRoadLane[2];
      } else {
        const mRuralLane = /^(.+?)(\d+巷)$/.exec(prefix);
        if (mRuralLane) {
          prefix = mRuralLane[1];
          laneRaw = mRuralLane[2];
        }
      }
    }

    const road = normRoad(prefix);
    const la = normLaneAlley(laneRaw, alleyRaw);
    const num = normNumber(numRaw);
    return {
      neighbor,
      village,
      road,
      lane: la.lane,
      alley: la.alley,
      laneAlley: la.laneAlley,
      numRaw,
      numKey: num.numKey,
      mainNum: num.mainNum,
      parity: num.parity
    };
  }

  function parseTwAddress(raw) {
    let s = toHalfWidth(raw);
    if (!s) return null;
    // 去掉開頭郵遞區號（3~6碼）或「台灣」「臺灣」國名
    s = s.replace(/^\d{3,6}/, "");
    s = s.replace(/^[台臺][灣彎](?=(?:台北市|臺北市|新北市|基隆市|桃園市|新竹|苗栗|台中|臺中|彰化|南投|雲林|嘉義|台南|臺南|高雄|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江))/, "");

    let county = "", dist = "", rest = s;
    for (const cKey of ALL_COUNTIES) {
      if (rest.startsWith(cKey)) {
        county = normCounty(cKey);
        rest = rest.slice(cKey.length);
        break;
      }
    }

    if (county && COUNTY_DISTS[county]) {
      const dists = COUNTY_DISTS[county];
      const sorted = dists.slice().sort((a, b) => b.length - a.length);
      for (const d of sorted) {
        const dAlt = d.replace(/臺/g, "台");
        if (rest.startsWith(d)) {
          dist = d;
          rest = rest.slice(d.length);
          break;
        }
        if (dAlt !== d && rest.startsWith(dAlt)) {
          dist = d;
          rest = rest.slice(dAlt.length);
          break;
        }
      }
    } else if (!county) {
      // 未寫縣市時，僅在唯一鄉鎮市區名且後面有門牌路巷特徵時自動推斷縣市
      const allDists = Object.keys(DIST_TO_COUNTIES).sort((a, b) => b.length - a.length);
      for (const d of allDists) {
        const owners = DIST_TO_COUNTIES[d];
        if (owners.length !== 1) continue;
        const dAlt = d.replace(/臺/g, "台");
        if (rest.startsWith(d)) {
          county = owners[0];
          dist = d;
          rest = rest.slice(d.length);
          break;
        }
        if (dAlt !== d && rest.startsWith(dAlt)) {
          county = owners[0];
          dist = d;
          rest = rest.slice(dAlt.length);
          break;
        }
      }
    }

    const parts = parseRoadLaneNum(rest);
    return {
      raw: String(raw || "").trim(),
      county,
      dist,
      ...parts,
      missingCounty: MISSING_COUNTIES.has(county),
      keyPath: county && dist && parts.road ? `${county}/${dist}/${parts.road}.json.gz` : ""
    };
  }

  function isTwAddressQuery(q) {
    const t = toHalfWidth(q);
    if (!t || t.length < 3) return false;
    const p = parseTwAddress(t);
    if (!p) return false;
    const hasRoadMarker = /(?:路|街|大道|一段|二段|三段|四段|五段|六段|七段|八段|九段|十段|\d段|巷|弄)/.test(p.road || t);
    const hasNum = Boolean(p.numKey);
    if (p.county && (hasRoadMarker || (p.dist && hasNum))) return true;
    if (p.dist && (hasRoadMarker || hasNum)) return true;
    if (hasRoadMarker && hasNum) return true;
    return false;
  }

  // GRS80 TWD97 TM2（121° EPSG:3826 ／ 119° EPSG:3825）轉 WGS84
  function twd97ToWgs84(x, y, epsg = 3826) {
    const a = 6378137.0;
    const b = 6356752.314245;
    const lon0 = ((epsg === 3825 ? 119.0 : 121.0) * Math.PI) / 180.0;
    const k0 = 0.9999;
    const dx = 250000.0;
    const e2 = (a * a - b * b) / (a * a);
    const ep2 = e2 / (1.0 - e2);
    const M = y / k0;
    const mu = M / (a * (1.0 - e2 / 4.0 - (3.0 * e2 * e2) / 64.0 - (5.0 * e2 * e2 * e2) / 256.0));
    const e1 = (1.0 - Math.sqrt(1.0 - e2)) / (1.0 + Math.sqrt(1.0 - e2));
    const J1 = (3.0 * e1) / 2.0 - (27.0 * Math.pow(e1, 3)) / 32.0;
    const J2 = (21.0 * e1 * e1) / 16.0 - (55.0 * Math.pow(e1, 4)) / 32.0;
    const J3 = (151.0 * Math.pow(e1, 3)) / 96.0;
    const J4 = (1097.0 * Math.pow(e1, 4)) / 512.0;
    const fp = mu + J1 * Math.sin(2 * mu) + J2 * Math.sin(4 * mu) + J3 * Math.sin(6 * mu) + J4 * Math.sin(8 * mu);
    const sinfp = Math.sin(fp), cosfp = Math.cos(fp), tanfp = Math.tan(fp);
    const C1 = ep2 * cosfp * cosfp;
    const T1 = tanfp * tanfp;
    const R1 = (a * (1.0 - e2)) / Math.pow(1.0 - e2 * sinfp * sinfp, 1.5);
    const N1 = a / Math.sqrt(1.0 - e2 * sinfp * sinfp);
    const D = (x - dx) / (N1 * k0);
    const Q1 = (N1 * tanfp) / R1;
    const Q2 = (D * D) / 2.0;
    const Q3 = ((5.0 + 3.0 * T1 + 10.0 * C1 - 4.0 * C1 * C1 - 9.0 * ep2) * Math.pow(D, 4)) / 24.0;
    const Q4 = ((61.0 + 90.0 * T1 + 298.0 * C1 + 45.0 * T1 * T1 - 3.0 * C1 * C1 - 252.0 * ep2) * Math.pow(D, 6)) / 720.0;
    const lat = fp - Q1 * (Q2 - Q3 + Q4);
    const Q5 = D;
    const Q6 = ((1.0 + 2.0 * T1 + C1) * Math.pow(D, 3)) / 6.0;
    const Q7 = ((5.0 - 2.0 * C1 + 28.0 * T1 - 3.0 * C1 * C1 + 8.0 * ep2 + 24.0 * T1 * T1) * Math.pow(D, 5)) / 120.0;
    const lon = lon0 + (Q5 - Q6 + Q7) / cosfp;
    return {
      lat: +((lat * 180.0) / Math.PI).toFixed(6),
      lon: +((lon * 180.0) / Math.PI).toFixed(6)
    };
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000.0;
    const rad = Math.PI / 180;
    const p1 = lat1 * rad, p2 = lat2 * rad;
    const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // 分片值：精確單點為 [lat, lon]；同號多棟為 [lat, lon, [[lat,lon], ...]]，前兩位是最接近巷／路中心的代表點。
  function coordOf(v) {
    if (!v) return null;
    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number") return [v[0], v[1]];
    if (typeof v === "object" && v.lat != null && v.lon != null) return [v.lat, v.lon];
    return null;
  }
  function isMultiDoor(v) {
    return Array.isArray(v) && Array.isArray(v[2]) && v[2].length > 1;
  }
  function doorHit(v, numKey) {
    const c = coordOf(v);
    if (!c) return null;
    const multi = isMultiDoor(v);
    return { lat: c[0], lon: c[1], precision: "門牌", precisionLabel: multi ? "同號多棟" : "門牌", matchedNum: numKey, multi };
  }

  // 在分片（或子分片）內查詢：
  // 1) 精確門牌（門牌／同號多棟）
  // 2) 同路／同巷最近號：優先同側單雙號，其次對側（最近號）
  // 3) 巷中心或路中心（路段）
  function pickNearestInMap(laneMap, mainNum, numKey) {
    if (!laneMap || mainNum == null) return null;
    let bestSame = null, bestSameDiff = Infinity, bestSameSub = Infinity;
    let bestOpp = null, bestOppDiff = Infinity, bestOppSub = Infinity;
    const targetParity = mainNum % 2;

    for (const k of Object.keys(laneMap)) {
      const m = /^[臨特]?(\d+)/.exec(k);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      const diff = Math.abs(n - mainNum);
      const subPen = k.length;
      const c = coordOf(laneMap[k]);
      if (!c) continue;
      if (n % 2 === targetParity) {
        if (diff < bestSameDiff || (diff === bestSameDiff && subPen < bestSameSub)) {
          bestSame = { key: k, coord: c, multi: isMultiDoor(laneMap[k]), diff };
          bestSameDiff = diff;
          bestSameSub = subPen;
        }
      } else {
        if (diff < bestOppDiff || (diff === bestOppDiff && subPen < bestOppSub)) {
          bestOpp = { key: k, coord: c, multi: isMultiDoor(laneMap[k]), diff };
          bestOppDiff = diff;
          bestOppSub = subPen;
        }
      }
    }
    return bestSame || bestOpp || null;
  }

  function lookupShardData(shard, parsed) {
    if (!shard) return null;
    const la = parsed.laneAlley || "";
    const d = shard.d || {};
    const laneMap = d[la];

    if (parsed.numKey && laneMap) {
      // 1. 精確門牌比對
      if (laneMap[parsed.numKey]) {
        return doorHit(laneMap[parsed.numKey], parsed.numKey);
      }
      // 嘗試剝除「附」或前綴「臨／特」的精確比對
      const fBase = parsed.numKey.replace(/f\d+$/, "");
      if (fBase !== parsed.numKey && laneMap[fBase]) {
        return doorHit(laneMap[fBase], fBase);
      }
      const noPre = parsed.numKey.replace(/^[臨特]/, "");
      if (noPre !== parsed.numKey && laneMap[noPre]) {
        return doorHit(laneMap[noPre], noPre);
      }

      // 2. 同路／同巷最近號（優先同側單雙號）
      if (parsed.mainNum != null) {
        const near = pickNearestInMap(laneMap, parsed.mainNum, parsed.numKey);
        if (near) {
          return { lat: near.coord[0], lon: near.coord[1], precision: "最近號", precisionLabel: "最近號", matchedNum: near.key };
        }
      }
    }

    // 若指定了巷弄但該巷弄無精確門牌，嘗試用該巷弄中心；再退回同路最近號或路中心
    if (la && shard.lc && shard.lc[la]) {
      return { lat: shard.lc[la][0], lon: shard.lc[la][1], precision: "路段", precisionLabel: "路段", matchedNum: "" };
    }
    if (parsed.lane && shard.lc && shard.lc[parsed.lane]) {
      return { lat: shard.lc[parsed.lane][0], lon: shard.lc[parsed.lane][1], precision: "路段", precisionLabel: "路段", matchedNum: "" };
    }
    if (parsed.mainNum != null && d[""]) {
      const nearRoad = pickNearestInMap(d[""], parsed.mainNum, parsed.numKey);
      if (nearRoad && la === "") {
        return { lat: nearRoad.coord[0], lon: nearRoad.coord[1], precision: "最近號", precisionLabel: "最近號", matchedNum: nearRoad.key };
      }
    }
    if (Array.isArray(shard.c) && shard.c.length === 2) {
      return { lat: shard.c[0], lon: shard.c[1], precision: "路段", precisionLabel: "路段", matchedNum: "" };
    }
    return null;
  }

  async function lookupInShard(shardOrMeta, parsed, loadSubShard) {
    if (!shardOrMeta) return null;
    if (shardOrMeta.split && typeof loadSubShard === "function") {
      const buckets = Array.isArray(shardOrMeta.b) ? shardOrMeta.b : [];
      if (parsed.mainNum != null && buckets.length) {
        const step = shardOrMeta.split;
        const want = Math.floor(parsed.mainNum / step) * step;
        // 挑目標桶或最接近的桶
        let targetBucket = buckets.includes(want) ? want : buckets.reduce((best, b) => Math.abs(b - want) < Math.abs(best - want) ? b : best, buckets[0]);
        const sub = await loadSubShard(targetBucket);
        const res = lookupShardData(sub, parsed);
        if (res) return res;
      }
      // 退回 meta 的巷中心／路中心
      const la = parsed.laneAlley || "";
      if (la && shardOrMeta.lc && shardOrMeta.lc[la]) {
        return { lat: shardOrMeta.lc[la][0], lon: shardOrMeta.lc[la][1], precision: "路段", precisionLabel: "路段", matchedNum: "" };
      }
      if (parsed.lane && shardOrMeta.lc && shardOrMeta.lc[parsed.lane]) {
        return { lat: shardOrMeta.lc[parsed.lane][0], lon: shardOrMeta.lc[parsed.lane][1], precision: "路段", precisionLabel: "路段", matchedNum: "" };
      }
      if (Array.isArray(shardOrMeta.c) && shardOrMeta.c.length === 2) {
        return { lat: shardOrMeta.c[0], lon: shardOrMeta.c[1], precision: "路段", precisionLabel: "路段", matchedNum: "" };
      }
      return null;
    }
    return lookupShardData(shardOrMeta, parsed);
  }

  const api = {
    COUNTY_DISTS,
    MISSING_COUNTIES,
    toHalfWidth,
    normCounty,
    normRoad,
    normLaneAlley,
    normNumber,
    parseRoadLaneNum,
    parseTwAddress,
    isTwAddressQuery,
    twd97ToWgs84,
    haversineM,
    coordOf,
    isMultiDoor,
    doorHit,
    lookupShardData,
    lookupInShard
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Geocode = api;
})(typeof self !== "undefined" ? self : this);

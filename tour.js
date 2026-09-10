// ═══════════════════════════════════════════════════════════════
//  tour.js — 各頁「第一次使用教學」(v566)
//  ─ 聚光燈式:背景暗掉、只亮現在講的那個元件，底下小卡說明，可 上一步/下一步/跳過
//  ─ 每一頁 (或頁內的某個畫面) 一組步驟，元素不存在或看不到的步驟自動略過
//  ─ 每組只自動跑一次:localStorage tour_done:{id} (裝置層級);左下角 ❓ 可隨時重看
//  ─ 有登入/訂閱鎖 overlay 在時不啟動 (等使用者進到真正畫面再教)
//  載入位置:</body> 前 (需要 DOM);對外 window.Tour = { start(id), reset(id), list() }
// ═══════════════════════════════════════════════════════════════
(function () {
  var CSS =
    "#tour-spot{position:fixed;z-index:13000;border-radius:14px;box-shadow:0 0 0 9999px rgba(20,18,30,.62),0 0 0 3px #fff,0 0 22px rgba(255,255,255,.35);pointer-events:none;transition:all .28s ease}" +
    "#tour-card{position:fixed;z-index:13001;width:min(320px,calc(100vw - 32px));background:#fff;color:#1f2937;border-radius:16px;padding:.95rem 1.05rem 1rem;box-shadow:0 12px 40px rgba(0,0,0,.35);font-family:'Noto Sans TC',system-ui,sans-serif;font-size:.92rem;line-height:1.6}" +
    "#tour-card .tc-step{font-size:.7rem;color:#9ca3af;letter-spacing:.08em;margin-bottom:.25rem}" +
    "#tour-card .tc-title{font-weight:900;font-size:1.02rem;margin-bottom:.3rem}" +
    "#tour-card .tc-body{color:#4b5563;font-size:.88rem}" +
    "#tour-card .tc-btns{display:flex;gap:.45rem;margin-top:.8rem;align-items:center}" +
    "#tour-card button{font:inherit;font-size:.84rem;font-weight:700;border-radius:999px;padding:.4rem .95rem;cursor:pointer;border:1.5px solid #e5e7eb;background:#fff;color:#374151}" +
    "#tour-card .tc-next{background:#7c3aed;border-color:#7c3aed;color:#fff;margin-left:auto}" +
    "#tour-card .tc-skip{border:0;color:#9ca3af;padding-left:.2rem}" +
    "#tour-card::before{content:'';position:absolute;width:14px;height:14px;background:#fff;transform:translateX(-50%) rotate(45deg);left:var(--tc-ax,35px)}" +
    "#tour-card.below::before{top:-7px}#tour-card.above::before{bottom:-7px}" +
    "#tour-card.noarrow::before{display:none}" +
    "#tour-help{position:fixed;left:12px;bottom:62px;z-index:12000;width:40px;height:40px;border-radius:50%;border:1.5px solid rgba(0,0,0,.12);background:#fff;box-shadow:0 3px 10px rgba(0,0,0,.15);cursor:pointer;font-size:1.1rem;display:grid;place-items:center;padding:0;font-family:system-ui}" +
    "#tour-help:hover{transform:scale(1.06)}" +
    "@media (max-width:899px){#tour-help{left:0;bottom:14px;top:auto;width:28px;height:32px;border-radius:0 12px 12px 0;border-left:0;font-size:.9rem;opacity:.8;transition:bottom .2s}}" + // v624: HUA — 手機放左下角,不要卡在左邊中間
    "@media print{#tour-help,#tour-spot,#tour-card{display:none!important}}" +
    "body.tour-open{overflow:hidden}";

  // ── 每頁的步驤 ──
  // s = 選擇器, t = 標題, b = 說明。trigger = 這組要在哪個元素看得到時才跑 (沒寫 = 頁面載入)
  var TOURS = {
    home: {
      match: function (p) {
        return (
          /(^|\/)(index\.html)?$/.test(p) &&
          !/\/(exam|ya\d|story|game)\//.test(p)
        );
      },
      trigger: "#main-content",
      steps: [
        {
          s: "#tour-help",
          t: "先認識這顆 ❓",
          b: "任何一頁不會用，左下角都有這個問號。點一下就會像現在這樣一步一步用聚光燈教你，隨時可以重看。",
        },
        {
          s: ".hero-cta",
          t: "先看這裡",
          b: "作者怎麼用這個網站、一個半月考到平均 80 分。第一次來建議先花兩分鐘看完。",
        },
        {
          s: ".countdown",
          t: "距離下次國考",
          b: "每天打開都提醒你還剩幾天，粗估值，精確日期以考選部公告為準。",
        },
        {
          s: 'a.card[href^="exam/"]',
          t: "練習本 — 主戰場",
          b: "" + SITE.yearSpanText + "歷屆、" + (typeof QUESTIONS !== "undefined" ? QUESTIONS.length : "全部") + " 題，作者已全部分門別類。照試卷練或照分類練，每題都能標記，錯的會自動整理。",
        },
        {
          s: 'a.card[href$="#notebook"]',
          t: "我的筆記本",
          b: "第一次先點進來，照步驟設定好 Gemini API (或 GitHub)。之後做題時把題目丟進來,AI 就會幫你整理成共筆等級的筆記，類似題會串在一起。",
        },
        {
          s: 'a.card[href="mnemonics.html"]',
          t: "口訣與重點分享區",
          b: SITE.subjRange + "分科，大家一起寫口訣，有版本歷史。",
        },
        {
          s: 'a.card[href="subscribe.html"]',
          t: "訂閱方案",
          b: "免費試用 7 天，之後在這裡續。想支持作者也是這裡。",
        },
        {
          s: 'a.card[href="rewards.html"]',
          t: "我的獎勵",
          b: "推薦朋友訂閱，你會自動收到 30 天序號，可以自己用或送人。",
        },
      ],
    },
    examHome: {
      match: function (p) {
        return /\/exam\/(index\.html)?$/.test(p);
      },
      trigger: "#screen-home .home-modes",
      steps: [
        {
          s: "#hm-paper",
          t: "照試卷練",
          b: "選一份年度試卷,80 題完整走一遍。適合模擬考、抓手感。",
        },
        {
          s: "#hm-topic",
          t: "照分類練 — 最厲害的功能之一",
          b: "" + (typeof QUESTIONS !== "undefined" ? QUESTIONS.length : "全部") + " 題已全部分門別類。挑一個分類，把 11 年來同一個觀念的題目一次寫熟、集中火力。每個分類做過幾題、錯誤率多少一眼看到。",
        },
        {
          s: "#home-how",
          t: "作答方式",
          b: "邊做邊看答案，或模擬考交卷才看。隨機、計時在這裡勾。",
        },
        {
          s: "#home-start",
          t: "開始",
          b: "這裡會告訴你目前條件符合幾題，按下去就開始。",
        },
        {
          s: "#chips-status",
          t: "篩選標記",
          b: "只練「一知半解」或「不需要懂」？在這裡選一種標記，開始練習就只出那些題。今天標、明天篩，弱點一次補完。",
        },
        {
          s: "#stats-card",
          t: "你的標記統計",
          b: "送分題 / 一知半解 / 亂猜一通 / 不需要懂 各有幾題，一目了然。",
        },
        {
          s: "#btn-resume",
          t: "↩ 回到考題（很重要）",
          b: "寫到一半突然想翻筆記本或口訣區？直接去。回來按這顆，一秒跳回剛剛那份考卷的那一題，不會從頭來。關掉網頁、換手機換電腳也一樣接得上。（開始寫題後這顆才會出現）",
          reveal: true, // v636: 還沒寫過題時這顆是藏的,教學會先把它露出來講,講完再藏回去
        },
        {
          s: "#btn-browse",
          t: "瀏覽：用關鍵字找題目",
          b: "想找某個關鍵字的所有題目？點「瀏覽」，打關鍵字或題號就把 11 年的題目全翻出來，還能照科目、標記篩。",
        },
        {
          s: "#btn-wrongbook",
          t: "錯題本",
          b: "作答時按 🚩 自己加進來的題目都在這裡，考前回來掃一遍。（🟢🤔🟡🔴 標記題不在這，用上面的「篩選標記」直接篩來練）",
        },
        {
          s: "#btn-notebook",
          t: "筆記本",
          b: "AI 幫你做的筆記在這裡，跨章節搜尋。",
        },
      ],
    },
    examPractice: {
      match: function (p) {
        return /\/exam\/(index\.html)?$/.test(p);
      },
      trigger: "#screen-practice #pq-options",
      steps: [
        { s: "#pq-options", t: "選項可以劃線、螢光筆", b: "點選項文字一下是刪去線，再點一下是螢光筆，像在紙本上作記號，下次回來還在。" },
        { s: "#btn-similar-qs-top", t: "右上角：10 題類似題", b: "一題卡住？點這裡拉出同一個觀念的 10 題類似題，一次把這個洞補起來。" },
        { s: "#ans-0", t: "按 A B C D 作答", b: "答完立刻看對錯與詳解（模擬考模式則交卷才看）。答完之後還會有一段教學，介紹詳解區的工具。" },
        { s: "#btn-skip", t: "跳過", b: "不想寫這題就跳過，之後可以再回來。" },
      ],
    },
    examAnswered: {
      match: function (p) {
        return /\/exam\/(index\.html)?$/.test(p);
      },
      trigger: "#screen-practice #result-banner",
      steps: [
        { s: "#result-banner", t: "答完了", b: "對錯馬上告訴你，下面是這題的詳解區。" },
        { s: "#pq-expl .gemini-expl", t: "Gemini 詳解", b: "為什麼選這個、其他選項為什麼錯。正確率九成以上，看不懂可以往下用工具。" },
        { s: "#pq-expl .clinical-expl", t: "臨床意義", b: "這題在臨床上代表什麼、會怎麼考。點開看。" },
        { s: "#pq-expl .nb-expl", t: "NotebookLM 詳解", b: "完全依據考選部公布的最新參考書做的第二套詳解，跟 Gemini 對照著看更放心。" },
        { s: '#pq-expl button[onclick*="regenerateGeminiExpl"]', t: "請 Gemini 重生詳解", b: "覺得這篇詳解不夠好？按一下用最新版重新生成一份（只影響你自己看到的）。" },
        { s: '#pq-expl button[onclick*="generateRelatedTable"]', t: "請 Gemini 做表格", b: "不想看一大段文字？讓 Gemini 把選項對照、鑑別診斷整理成一張表。" },
        { s: "#btn-edit-expl", t: "編輯詳解", b: "詳解有錯或想補充？自己改，改完只有你看得到。" },
        { s: '[id^="qc-ya"]', t: "留言區", b: "對這題有想法、有補充，留在底下跟其他考生互相取暖；學霸也可以在這裡寫詳解。" },
        { s: "#mk-flag", t: "🚩 加進錯題本", b: "覺得這題要再回來寫，按一下收進錯題本（錯題本只放你自己加的）。" },
        { s: ".mark-row", t: "標記這一題", b: "🟢 送分題 ❓ 一知半解 🤔 亂猜一通 ❌ 不需要懂。回練習本首頁用「篩選標記」就能只練某一種。" },
        { s: "#btn-add-notebook", t: "加入筆記本", b: "值得記的題丟進筆記本，AI 在背景幫你整理，不會打斷作答。（要先在筆記本設定好 Gemini API 才會動）" },
        { s: "#qgrid-toggle", t: "題號總覽", b: "這份試卷每一題的作答狀況一格一格看，點題號直接跳過去。" },
        { s: "#btn-next", t: "下一題", b: "看完就往下寫。祝順利！" },
      ],
    },
    notebook: {
      match: function (p) {
        return /\/exam\/(index\.html)?$/.test(p);
      },
      trigger: "#screen-notebook #notebook-toc",
      steps: [
        { s: "#nb-more > .nb-tb-btn", t: "第一步：先看入門指引", b: "點「更多」→「入門指引」。筆記本要先設定 Gemini API（或 GitHub）才會開始幫你做筆記，照步驟設定一次就好。子主題分組、合併重複章節、歷史、還原備份、匯出、列印也都收在「更多」裡。" },
        { s: '.nb-tb-btn[onclick="openAISettings()"]', t: "⚙️ 設定", b: "之後要改 API key、換模型、改 GitHub token，都在這裡。" },
        { s: "#btn-pending", t: "📥 待整理", b: "你在作答時按「加入筆記本」的題目會先排在這裡，AI 會在背景一題一題整理。" },
        { s: "#nb-search-input", t: "搜尋筆記", b: "跨章節、跨科目找關鍵字。" },
        { s: "#nb-star-filter", t: "⭐ 只看重點", b: "把你標了星號的段落篩出來，考前衝刺用。（手機上目錄側欄從左邊滑出來，平常點左上角的 ☰ 開）" },
        { s: "#notebook-toc", t: "目錄", b: "AI 會把類似題串進同一個章節，目錄在這裡。點章節名可以改名。" },
        { s: "#notebook-body", t: "筆記內容", b: "共筆等級的整理。點段落可以直接編輯、加星號、貼圖（要有 GitHub token）。貼圖小撇步：截圖後直接 Ctrl+V 貼上，Windows 按 Win+Shift+S、Mac 按 Cmd+Ctrl+Shift+4。" },
        { s: '.nb-tb-btn[onclick="undoLastChange()"]', t: "↶ 復原", b: "AI 改壞了或自己改錯了，一鍵回上一步。" },
      ],
    },
    examBrowse: {
      match: function (p) {
        return /\/exam\/(index\.html)?$/.test(p);
      },
      trigger: "#screen-browse #bf-search-input",
      steps: [
        { s: "#bf-search-input", t: "打關鍵字找題目", b: "題目、選項、詳解、題號（例如 " + SITE.exampleQid + "）都搜得到。邊打邊出結果，11 年 7040 題一次翻完。" },
        { s: "#bf-row", t: "照標記、科目篩", b: "只看某一科、或只看你標了「一知半解」「不需要懂」的題目，點一下就篩。" },
        { s: "#bf-quiz-mode", t: "先不看答案", b: "勾起來，展開題目時答案先藏著，自己選一個才顯示對錯和詳解，等於用搜尋結果來練習。" },
        { s: "#bf-qa-only", t: "只比對題目與選項", b: "關鍵字太常見、結果太多時勾這個，就不掃詳解，命中更精準。" },
        { s: "#bf-result-count", t: "結果數", b: "這裡顯示目前篩出幾題，一次列 30 題，往下有「載入更多」。" },
      ],
    },
    wrongbook: {
      match: function (p) {
        return /\/exam\/(index\.html)?$/.test(p);
      },
      trigger: "#screen-wrongbook .wb2-summary",
      steps: [
        { s: "#wb2-summary", t: "錯題本一眼看完", b: "全部幾題、幾題還沒答對過、幾題標了再努力、這週新加幾題。點數字可以直接套篩選。" },
        { s: "#wb-mark-filters", t: "照標記篩", b: "只想練「不需要懂」？點一下就只剩那些。" },
        { s: "#wb2-search", t: "搜尋", b: "記得關鍵字或題號（例如 111-1-3）就直接搜。" },
        { s: ".wb2-acc", t: "先看分類，點開才看題", b: "幾百題也不用一直滑：每個分類一行，有幾題、幾題還沒答對、一條進度條。點開才列題目，一題一行，「練」直接進那題，「移出」拿掉 🚩。" },
        { s: "#wb2-start", t: "開始練", b: "順序或隨機、只練還沒答對的、答對就自動移出 🚩，勾好按開始。" },
      ],
    },
    mnemonics: {
      match: function (p) {
        return /\/mnemonics\.html$/.test(p);
      },
      trigger: ".subject-tabs",
      steps: [
        {
          s: "#mn-tabs",
          t: "三個分頁",
          b: "「我的口訣」是你自己的，預設只有你看得到。「我的最愛」放你收藏的別人章節。「大家分享的」照科目、分類看大家公開的口訣。",
        },
        { s: ".subject-tabs", t: "選科目", b: SITE.subjRange + "，每科各自一份口訣。" },
        { s: ".search-row", t: "跨科搜尋", b: "記得關鍵字就直接搜，" + SITE.subjCountCN + "科一起找。" },
        { s: ".chapter-list", t: "章節列表", b: "點一個章節，內容會出現在下面（手機會自動捲過去）。" },
        { s: "#btn-add-ch", t: "新增章節", b: "有編輯權的人可以在這裡開一個新章節，寫自己的口訣。" },
        { s: ".editor-card", t: "口訣內容", b: "這裡就是口訣本身。有編輯權的人可以寫；其他人可看、可留言。" },
        { s: "#edit-btn", t: "✏ 編輯", b: "按一下進入編輯模式，可以打字、貼圖、排版。貼圖最快的方法：電腦截圖後直接 Ctrl+V 貼上（Windows 按 Win+Shift+S，Mac 按 Cmd+Ctrl+Shift+4 會存到剪貼簿）。要先在筆記本設定好 GitHub token。" },
        { s: "#save-btn", t: "💾 儲存", b: "改完按儲存，會推到雲端讓大家看到；每次儲存都留一個版本。" },
        { s: "#undo-btn", t: "↶ 回復", b: "剛剛存錯了？一鍵回到上一版。" },
        {
          s: "#pub-toggle",
          t: "公開分享",
          b: "想分享給大家就打開它。一定要先選分類，複製別人的章節不能再公開。公開後別人可以按讚、收藏、留言。旁邊「已有口訣」打勾，章節標題會變綠字；黑字代表是沒口訣的重點整理。",
        },
        { s: "#link-btn", t: "🔗 複製連結", b: "把這個章節的網址複製出去分享。注意：只有試用中或訂閱中的會員才打得開。" },
        { s: ".comments-open-btn", t: "留言", b: "對這章有想法或補充，留言給大家。" },
      ],
    },
    subscribe: {
      auto: false,
      match: function (p) {
        return /\/subscribe\.html$/.test(p);
      },
      trigger: "#plans",
      steps: [
        {
          s: "#status-card",
          t: "你的狀態",
          b: "試用還剩幾天、會員到哪天，都在這裡。",
        },
        {
          s: "#plans",
          t: "選方案",
          b: "月費 / 季費 / 半年，選了下面會出現匯款資訊。",
        },
        {
          s: "#redeem-box",
          t: "有序號?",
          b: "推薦獎勵或朋友送的序號，在這裡輸入直接開通 30 天。",
        },
      ],
    },
    rewards: {
      auto: false,
      match: function (p) {
        return /\/rewards\.html$/.test(p);
      },
      trigger: "#rewards-list",
      steps: [
        {
          s: ".hint",
          t: "怎麼拿獎勵",
          b: "朋友訂閱時填你的 Google email 當推薦人，開通後你會自動收到 30 天序號。",
        },
        {
          s: "#rewards-list",
          t: "你的序號",
          b: "在這裡直接「續命 30 天」自己用，或複製送人。",
        },
      ],
    },
    feedback: {
      auto: false,
      match: function (p) {
        return /\/feedback\.html$/.test(p);
      },
      trigger: ".type-row",
      steps: [
        {
          s: ".type-row",
          t: "許願或回報 Bug",
          b: "選一個類型。作者有時間一定第一時間處理。",
        },
        {
          s: "textarea",
          t: "寫下來",
          b: "越具體越好:哪一頁、哪一題、發生什麼事。",
        },
      ],
    },
    devices: {
      match: function (p) {
        return /\/devices\.html$/.test(p);
      },
      trigger: "#device-list, .device-row",
      steps: [
        {
          s: "#device-list, .device-row",
          t: "你的裝置",
          b: "同一帳號最多三台。多出來的會被自動登出，也可以在這裡手動移除。",
        },
      ],
    },
    subject: {
      match: function (p) {
        return /\/ya[3-6]\/(index\.html)?$/.test(p);
      },
      trigger: ".home-cards",
      steps: [
        {
          s: ".home-cards",
          t: "選一個分科",
          b: "點進去是這科的互動筆記:左邊目錄、右邊內容，依出題頻率標色。",
        },
      ],
    },
    subjectSection: {
      match: function (p) {
        return /\/ya[3-6]\/(index\.html)?$/.test(p);
      },
      trigger: ".section-view .content-body, .content-body",
      steps: [
        {
          s: ".menu-btn, .sidebar",
          t: "目錄",
          b: "章節目錄在這裡 (手機是左上角 ☰)。紅點是極高頻必考。",
        },
        { s: ".search-box", t: "搜尋", b: "輸入關鍵字，直接跳到那一段。" },
        { s: ".review-btn", t: "讀完打勾", b: "讀完一節按一下，進度會記住。" },
      ],
    },
    story: {
      match: function (p) {
        return /\/story\/(index\.html)?$/.test(p);
      },
      trigger: ".book-grid",
      steps: [
        {
          s: ".book-grid",
          t: "選一本故事書",
          b: "用醫師和學生的對話把難懂的觀念講成故事，先懂再背。灰色的是即將推出。",
        },
      ],
    },
  };

  var KEY = "tour_done:";
  var active = null; // {id, steps, i}
  var els = {};

  function done(id) {
    try {
      return localStorage.getItem(KEY + id) === "1";
    } catch (e) {
      return false;
    }
  }
  function markDone(id) {
    try {
      localStorage.setItem(KEY + id, "1");
    } catch (e) {}
  }
  // v661:「已經不是第一次使用就不用每次都跳出教學」(HUA)
  //   看過 2 組以上、或第一次來超過 3 天 → 當作老手,不再自動跳;左下角 ❓ 隨時能看
  var FIRST_KEY = "tour_first_seen";
  var SESS_KEY = "tour_auto_session";
  function firstSeen() {
    try {
      var v = +localStorage.getItem(FIRST_KEY) || 0;
      if (!v) {
        v = Date.now();
        localStorage.setItem(FIRST_KEY, String(v));
      }
      return v;
    } catch (e) {
      return Date.now();
    }
  }
  function doneCount() {
    try {
      var c = 0;
      for (var i = 0; i < localStorage.length; i++)
        if ((localStorage.key(i) || "").indexOf(KEY) === 0) c++;
      return c;
    } catch (e) {
      return 0;
    }
  }
  function isVeteran() {
    return doneCount() >= 2 || Date.now() - firstSeen() > 3 * 86400000;
  }
  function autoUsedThisSession() {
    try {
      return sessionStorage.getItem(SESS_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  function markAutoUsed() {
    try {
      sessionStorage.setItem(SESS_KEY, "1");
    } catch (e) {}
  }
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      getComputedStyle(el).visibility !== "hidden"
    );
  }
  function q(sel) {
    var list = sel.split(",");
    for (var i = 0; i < list.length; i++) {
      var els2 = document.querySelectorAll(list[i].trim());
      for (var j = 0; j < els2.length; j++)
        if (visible(els2[j])) return els2[j];
    }
    return null;
  }
  function blocked() {
    var o = document.getElementById("sub-block-overlay");
    if (o && visible(o)) return true;
    var u = document.getElementById("user-overlay");
    if (u && visible(u) && !u.classList.contains("hidden")) return true;
    var d = document.getElementById("device-block-overlay");
    if (d && visible(d)) return true;
    var ob = document.getElementById("onboarding-overlay"); // 筆記本的新手入門設定視窗
    if (ob && visible(ob)) return true;
    return false;
  }

  var cssDone = false;
  function injectCSS() {
    if (cssDone) return;
    cssDone = true;
    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function ensureEls() {
    injectCSS();
    if (!els.spot) {
      els.spot = document.createElement("div");
      els.spot.id = "tour-spot";
      els.card = document.createElement("div");
      els.card.id = "tour-card";
      els.card.innerHTML =
        '<div class="tc-step"></div><div class="tc-title"></div><div class="tc-body"></div>' +
        '<div class="tc-btns"><button type="button" class="tc-skip">跳過教學</button><button type="button" class="tc-prev">上一步</button><button type="button" class="tc-next">下一步</button></div>';
      els.card.querySelector(".tc-skip").onclick = function () {
        end(true);
      };
      els.card.querySelector(".tc-prev").onclick = function () {
        go(active.i - 1);
      };
      els.card.querySelector(".tc-next").onclick = function () {
        go(active.i + 1);
      };
      document.addEventListener("keydown", function (e) {
        if (!active) return;
        if (e.key === "Escape") end(true);
        if (e.key === "ArrowRight" || e.key === "Enter") go(active.i + 1);
        if (e.key === "ArrowLeft") go(active.i - 1);
      });
      window.addEventListener("resize", function () {
        if (active) place();
      });
      window.addEventListener(
        "scroll",
        function () {
          if (active) place();
        },
        true,
      );
    }
  }

  function start(id) {
    var t = TOURS[id];
    if (!t) return false;
    var steps = t.steps.filter(function (s) {
      if (q(s.s)) return true;
      // 在收合的 details 裡也算 (顯示那步時會先展開)
      var any = document.querySelector(s.s.split(",")[0].trim());
      if (any && any.closest("details")) return true;
      // v636: 標了 reveal 的 (例如「回到考題」還沒出現) 或藏在手機收合頁首裡的分頁鈕 → 顯示那步時會先露出來
      return !!(any && (s.reveal || any.closest(".header-right")));
    });
    if (!steps.length) return false;
    ensureEls();
    if (active) end(false);
    active = { id: id, steps: steps, i: 0 };
    document.documentElement.appendChild(els.spot); // v608: 掛在 <html> 不掛 body — body 有 filter/transform (筆記主題飽和度、風格) 時 fixed 會跟著 body 捲,手機聚光燈就對不準
    document.documentElement.appendChild(els.card);
    go(0);
    return true;
  }
  function openDetails(sel) {
    // 目標藏在收合的 <details> 裡 (例如 Gemini 詳解裡的按鈕) → 先把外層 details 全打開
    var list = sel.split(",");
    for (var i = 0; i < list.length; i++) {
      var cands = document.querySelectorAll(list[i].trim());
      for (var j = 0; j < cands.length; j++) {
        var d = cands[j].closest("details");
        var changed = false;
        while (d) {
          if (!d.open) {
            var sm = d.querySelector("summary");
            if (sm) sm.click(); else d.open = true; // 用點 summary 的方式展開,頁面自己的 toggle 邏輯才會跑
            changed = true;
          }
          d = d.parentElement && d.parentElement.closest("details");
        }
        if (changed && visible(cands[j])) return true;
      }
    }
    return false;
  }
  function go(i) {
    if (!active) return;
    if (i < 0) i = 0;
    if (i >= active.steps.length) {
      end(true);
      return;
    }
    active.i = i;
    var s = active.steps[i];
    unreveal(); // v636: 上一步若有暫時露出的東西先收回
    var el = q(s.s);
    if (el && el.closest("details") && !el.closest("details").open) openDetails(s.s);
    if (!el && openDetails(s.s)) el = q(s.s);
    if (!el) el = reveal(s);
    if (!el) {
      active.steps.splice(i, 1);
      if (!active.steps.length) return end(true);
      return go(Math.min(i, active.steps.length - 1));
    }
    active.el = el;
    // v613: 目標在手機收起的側欄 (.nb-toc-pane 等 fixed 在畫面外的面板) 裡 → 教學期間先把它打開,離開時關回去
    var pane = el.closest(".nb-toc-pane");
    if (pane) {
      var pr = pane.getBoundingClientRect();
      if ((pr.right <= 0 || pr.left >= window.innerWidth) && !pane.classList.contains("open")) {
        pane.classList.add("open");
        pane.style.zIndex = "12500"; // 要壓過頁首 (z 11000),不然聚光燈對到的是被頁首蓋住的位置
        active.openedPane = pane;
      }
    } else if (active.openedPane) {
      active.openedPane.classList.remove("open");
      active.openedPane.style.zIndex = "";
      active.openedPane = null;
    }
    els.card.querySelector(".tc-step").textContent =
      i + 1 + " / " + active.steps.length;
    els.card.querySelector(".tc-title").textContent = s.t;
    els.card.querySelector(".tc-body").textContent = s.b;
    els.card.querySelector(".tc-prev").style.visibility =
      i === 0 ? "hidden" : "visible";
    els.card.querySelector(".tc-next").textContent =
      i === active.steps.length - 1 ? "完成 ✓" : "下一步";
    // v613: sticky 容器 (筆記本工具列) 捲下去會被 sticky 頁首蓋住,聚光燈對到的是被蓋住的位置 → 直接捲回最上面
    var stickyAnc = null, a = el, depth = 0;
    while (a && a !== document.body && depth++ < 6) {
      if (getComputedStyle(a).position === "sticky") { stickyAnc = a; break; }
      a = a.parentElement;
    }
    if (stickyAnc && !pane) {
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { window.scrollTo(0, 0); }
    } else if (!pane) {
      // 很高的目標 (整篇筆記內容) 用 center 會把頂端捲出畫面 → 改成「頂端對齊在 sticky 頁首下方一點」
      var er = el.getBoundingClientRect();
      if (er.height > window.innerHeight * 0.6) {
        var hdr = document.querySelector(".header, .nb-toolbar");
        var hh = hdr ? hdr.getBoundingClientRect().bottom : 0;
        try { window.scrollTo({ top: window.scrollY + er.top - Math.max(hh, 0) - 12, behavior: "smooth" }); } catch (e) { window.scrollTo(0, window.scrollY + er.top - 60); }
      } else {
        try {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        } catch (e) {
          el.scrollIntoView();
        }
      }
    }
    place();
    // 平滑捲動、字型載入、頁面自己重排 都會讓位置跑掉 → 前 1.2 秒多對幾次,之後每 400ms 再校正一次 (只有教學開著時)
    [120, 320, 600, 900, 1200].forEach(function (ms) { setTimeout(place, ms); });
  }
  setInterval(function () { if (active) place(); }, 400);
  function place() {
    if (!active || !active.el) return;
    var r = active.el.getBoundingClientRect();
    var pad = 8;
    // v608: iOS 手指縮放過時 fixed 是相對「視覺視窗」,getBoundingClientRect 是相對「版面視窗」→ 補上偏移
    var vv = window.visualViewport;
    var ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
    var vw = vv ? vv.width : window.innerWidth, vh = vv ? vv.height : window.innerHeight;
    r = { left: r.left - ox, top: r.top - oy, width: r.width, height: r.height, right: r.right - ox, bottom: r.bottom - oy };
    els.spot.style.left = r.left - pad + "px";
    els.spot.style.top = r.top - pad + "px";
    els.spot.style.width = r.width + pad * 2 + "px";
    els.spot.style.height = Math.min(r.height + pad * 2, vh - (r.top - pad) - 8) + "px"; // v613: 很高的目標不要超出視窗
    var cw = els.card.offsetWidth || 320, ch = els.card.offsetHeight || 160;
    var spaceBelow = vh - (r.bottom + 16), spaceAbove = r.top - 16;
    var below = spaceBelow >= ch || spaceBelow >= spaceAbove;
    var top = below ? r.bottom + 16 : r.top - 16 - ch;
    if (r.height > vh * 0.6) top = vh - ch - 8; // v613: 目標比視窗還高 (整篇筆記) → 卡片貼底,不要蓋住目標頂端
    top = Math.max(8, Math.min(top, vh - ch - 8));
    var left = Math.max(16, Math.min(r.left, vw - cw - 16));
    els.card.className = below ? "below" : "above";
    els.card.style.left = left + "px";
    els.card.style.top = top + "px";
    // v664: 箭頭指向目標的水平中心 (以前寫死在卡片左邊 28px,卡片被推開時就指到空氣)
    var cx = r.left + r.width / 2;
    var ax = cx - left;
    var gapOk = below
      ? Math.abs(top - r.bottom) < 60
      : Math.abs(r.top - (top + ch)) < 60;
    var overlapX = r.right > left + 6 && r.left < left + cw - 6;
    els.card.classList.toggle("noarrow", !(gapOk && overlapX));
    els.card.style.setProperty(
      "--tc-ax",
      Math.max(16, Math.min(ax, cw - 16)) + "px",
    );
  }
  // v636: 暫時露出目標 — (1) reveal 步驤:目標被 JS 藏起來 (display:none) 就先顯示;(2) 手機收合頁首:把頁首展開 (nav-open)。下一步或結束時 unreveal() 還原
  function reveal(s) {
    var raw = document.querySelector(s.s.split(",")[0].trim());
    if (!raw) return null;
    var hdr = raw.closest(".header");
    if (hdr && !hdr.classList.contains("nav-open")) {
      hdr.classList.add("nav-open");
      active.navOpened = hdr;
    }
    if (s.reveal && !visible(raw)) {
      active.revealed = { el: raw, disp: raw.style.display };
      raw.style.display = "inline-block";
    }
    return visible(raw) ? raw : null;
  }
  function unreveal() {
    if (!active) return;
    if (active.revealed) {
      active.revealed.el.style.display = active.revealed.disp;
      active.revealed = null;
    }
    if (active.navOpened) {
      active.navOpened.classList.remove("nav-open");
      active.navOpened = null;
    }
  }
  function end(mark) {
    if (!active) return;
    unreveal();
    if (mark) markDone(active.id);
    if (active.openedPane) { active.openedPane.classList.remove("open"); active.openedPane.style.zIndex = ""; } // v613
    active = null;
    if (els.spot && els.spot.parentNode)
      els.spot.parentNode.removeChild(els.spot);
    if (els.card && els.card.parentNode)
      els.card.parentNode.removeChild(els.card);
  }

  // ── 自動啟動:每 1.2 秒看一次有沒有「該跑、還沒跑過、觸發元素看得到」的教學 (一次只跑一組) ──
  var path = location.pathname;
  var mine = Object.keys(TOURS).filter(function (k) {
    return TOURS[k].match(path);
  });
  var pollN = 0;
  var poll = setInterval(function () {
    pollN++;
    if (pollN > 150) {
      clearInterval(poll);
      return;
    } // 3 分鐘後不再自動
    if (active || blocked()) return;
    // v661: 老手 / 這次已經自動跳過一組 → 不再自動跳
    if (isVeteran() || autoUsedThisSession()) {
      clearInterval(poll);
      return;
    }
    for (var i = 0; i < mine.length; i++) {
      var k = mine[i];
      if (done(k) || TOURS[k].auto === false) continue;
      if (!q(TOURS[k].trigger)) continue;
      // 等 skin/首頁初始化一拍再開
      setTimeout(
        (function (kk) {
          return function () {
            if (
              !active &&
              !done(kk) &&
              q(TOURS[kk].trigger) &&
              !blocked() &&
              !isVeteran() &&
              !autoUsedThisSession()
            ) {
              markAutoUsed();
              start(kk);
            }
          };
        })(k),
        900,
      );
      break;
    }
  }, 1200);

  // ── ❓ 重看教學 ──
  // v624: 手機版 ❓ 在左下角;底部有 sticky 作答列 (.nav-row / .wb2-bar 等) 時自動墊高到它上面
  function placeHelp() {
    var b = document.getElementById("tour-help");
    if (!b || window.innerWidth > 899) return;
    var bars = document.querySelectorAll("#screen-practice .nav-row, .nav-row.sticky, #wb2-start-bar");
    var h = 0;
    bars.forEach(function (el) {
      if (!el.offsetParent) return;
      var r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom >= window.innerHeight - 4 && r.top < window.innerHeight) h = Math.max(h, window.innerHeight - r.top);
    });
    b.style.bottom = (h ? h + 8 : 14) + "px";
  }
  setInterval(placeHelp, 700);
  window.addEventListener("resize", placeHelp);
  function buildHelp() {
    if (!mine.length || document.getElementById("tour-help")) return;
    injectCSS(); // v566: ❓ 鈕的樣式要先進來，不能等教學開始才注入
    var b = document.createElement("button");
    b.type = "button";
    b.id = "tour-help";
    b.title = "看這一頁的使用教學";
    b.textContent = "❓";
    b.onclick = function () {
      // 挑目前畫面上觸發元素看得到的那組;都沒有就第一組
      var pick = mine.filter(function (k) {
        return q(TOURS[k].trigger);
      });
      var k = pick.length ? pick[pick.length - 1] : mine[0];
      start(k);
    };
    document.documentElement.appendChild(b);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", buildHelp);
  else buildHelp();

  window.Tour = {
    start: start,
    end: function () {
      end(false);
    },
    reset: function (id) {
      try {
        if (id) localStorage.removeItem(KEY + id);
        else
          Object.keys(TOURS).forEach(function (k) {
            localStorage.removeItem(KEY + k);
          });
        // v661: 重看教學時把「老手」判斷一起歸零
        localStorage.removeItem(FIRST_KEY);
        sessionStorage.removeItem(SESS_KEY);
      } catch (e) {}
    },
    list: function () {
      return mine.slice();
    },
    _active: function () {
      return active;
    },
  };
})();

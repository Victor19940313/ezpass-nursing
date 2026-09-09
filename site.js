// site.js — 多站共用版的「科目設定表」讀取器
// 用法:每頁 <head> 最前面先載 site-config.js (組裝時由 sites/<id>/site.json 生成,定義 window.SITE),再載這支。
// 這支做四件事:
//   1. 從 SITE.subjects 派生常用查表 (SMAP / SCOLOR / SACCENT / SEMOJI / SUBJ_CODES / TOPICS …)
//   2. 注入科目顏色 CSS (--{code}、.chip-{code}.sel、.badge-{code}、口訣區 tabs、比較表/數字速查 tabs、留言分組色)
//   3. 填 <title data-site-title="{practiceIcon} {practiceName}"> 與 [data-site="欄位"] 的文字
//   4. 提供 Site.here(html) 讓頁面在原位同步渲染科目按鈕 (DOM 結構跟原本寫死的一樣)
(function () {
  var S = window.SITE;
  if (!S) {
    console.error(
      "[site] window.SITE 不存在 — site-config.js 要在 site.js 之前載入",
    );
    return;
  }
  var subs = S.subjects || [];
  function esc(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ── 1. 派生查表 ──
  S.SUBJ_CODES = subs.map(function (s) {
    return s.code;
  });
  S.SMAP = {};
  S.SCOLOR = {};
  S.SACCENT = {};
  S.SEMOJI = {};
  S.SEMOJI_NAME = {};
  S.SEMOJI_BY_NAME = {};
  S.TOPICS = {};
  S.SUBJ_BY_CODE = {};
  subs.forEach(function (s) {
    S.SMAP[s.code] = s.name;
    S.SCOLOR[s.code] = s.color;
    S.SACCENT[s.code] = s.accent || s.color;
    S.SEMOJI[s.code] = s.emoji || "📁";
    S.SEMOJI_NAME[s.code] = (s.emoji ? s.emoji + " " : "") + s.name;
    S.SEMOJI_BY_NAME[s.name] = s.emoji || "📁";
    S.TOPICS[s.code] = s.topics || ["其他"];
    S.SUBJ_BY_CODE[s.code] = s;
  });
  S.defaultSubject = S.defaultSubject || S.SUBJ_CODES[0];
  S.primarySubject = S.primarySubject || S.defaultSubject;
  S.SUBJ_PRIMARY_FIRST = [S.primarySubject].concat(
    S.SUBJ_CODES.filter(function (c) {
      return c !== S.primarySubject;
    }),
  );
  var names = subs
    .map(function (s) {
      return s.name;
    })
    .sort(function (a, b) {
      return b.length - a.length;
    })
    .map(esc);
  S.subjNameRe = new RegExp(names.length ? names.join("|") : "(?!)");
  S.subjNameLeadRe = new RegExp(
    "^(?:" + (names.length ? names.join("|") : "(?!)") + ")\\s*\\/\\s*",
  );
  S.subjRange = subs.length
    ? S.SMAP[S.SUBJ_CODES[0]] +
      "到" +
      S.SMAP[S.SUBJ_CODES[S.SUBJ_CODES.length - 1]]
    : "";
  S.subjCount = subs.length;
  S.subjCountCN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][subs.length] || String(subs.length);
  S.fullName = (S.brand ? S.brand + " " : "") + S.examName + "互動筆記";
  S.practiceTitle =
    (S.practiceIcon ? S.practiceIcon + " " : "") + S.practiceName;
  S.nextExam = S.nextExam || {};
  S.nextExamNote = S.nextExam.note || "";
  S.domainBySubject = S.domainBySubject || {};
  S.domainAliases = S.domainAliases || {};
  S.domains = S.domains || [];
  S.topicCats = S.topicCats || [];
  S.years = S.years || [];
  S.defaultYear = S.defaultYear || S.years[S.years.length - 1] || "";
  var yearSet = {};
  S.years.forEach(function (y) { yearSet[String(y).split("-")[0]] = 1; });
  S.yearSpanText = Object.keys(yearSet).length + " 年";
  S.ai = S.ai || {};
  S.ai.termReplacements = S.ai.termReplacements || [];
  S.ai.noRefTopics = S.ai.noRefTopics || [];
  S.ai.termsRule = S.ai.termsRule || "";
  S.ai.explExamples = S.ai.explExamples || "";
  S.ai.triggerExamples = S.ai.triggerExamples || "";
  S.pdfHint = S.pdfHint || "";
  S.exampleQid = S.exampleQid || S.primarySubject + "-" + S.defaultYear + "-1";

  // ── 2. 科目 CSS ──
  var css = ":root{";
  subs.forEach(function (s) {
    css +=
      "--" +
      s.code +
      ":" +
      s.color +
      ";--" +
      s.code +
      "-accent:" +
      S.SACCENT[s.code] +
      ";";
  });
  css += "--subj-primary:" + (S.SCOLOR[S.primarySubject] || "#3730a3") + "}";
  subs.forEach(function (s) {
    var c = s.code,
      a = S.SACCENT[c],
      bg = s.bg || "#f3f4f6",
      fg = s.fg || s.color;
    css +=
      ".chip-" +
      c +
      ".sel{background:" +
      bg +
      ";border-color:" +
      a +
      ";color:" +
      fg +
      "}" +
      ".badge-" +
      c +
      "{background:" +
      bg +
      ";color:" +
      fg +
      "}" +
      '.subject-tabs button.active[data-subject="' +
      c +
      '"]{background:var(--' +
      c +
      ");border-color:var(--" +
      c +
      ")}" +
      '.tab[data-subject="' +
      c +
      '"].active,.tab[data-s="' +
      c +
      '"].active{background:' +
      a +
      ";border-color:" +
      a +
      "}" +
      '.card-subject[data-s="' +
      c +
      '"]{background:' +
      bg +
      ";color:" +
      a +
      "}" +
      ".subj-" +
      c +
      "{background:" +
      a +
      "}" +
      'tbody tr[data-subj="' +
      c +
      '"]{border-left-color:' +
      a +
      "}" +
      '.qc-md-subj-group[data-subj="' +
      c +
      '"]{border-color:' +
      a +
      "80}" +
      '.qc-md-subj-group[data-subj="' +
      c +
      '"] .qc-md-subj-header{background:' +
      bg +
      ";color:" +
      fg +
      "}";
  });
  var st = document.createElement("style");
  st.id = "site-subject-css";
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  // ── 3. 文字填入 ──
  function tpl(str) {
    return String(str).replace(/\{(\w+)\}/g, function (_, k) {
      return S[k] != null ? S[k] : "";
    });
  }
  function fillTitle() {
    var t = document.querySelector("title[data-site-title]");
    if (t) document.title = tpl(t.getAttribute("data-site-title"));
  }
  function fill() {
    fillTitle();
    if (typeof QUESTIONS !== "undefined" && QUESTIONS.length) S.questionCount = String(QUESTIONS.length); // 練習本題庫載入後才有
    document.querySelectorAll("[data-site]").forEach(function (el) {
      var v = S[el.getAttribute("data-site")];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll("[data-site-placeholder]").forEach(function (el) {
      el.placeholder = tpl(el.getAttribute("data-site-placeholder"));
    });
  }
  fillTitle();
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", fill);
  else fill();

  // ── 4. 原位渲染 ──
  function here(html) {
    var sc = document.currentScript;
    if (!sc) return;
    sc.insertAdjacentHTML("beforebegin", html);
    sc.remove();
  }
  function subjectButtons(fn, codes) {
    return (codes || S.SUBJ_CODES)
      .map(function (c) {
        return fn(S.SUBJ_BY_CODE[c], c);
      })
      .join("");
  }
  function sessionLabel(sess) {
    var L = S.sessionLabels || { 1: "上", 2: "下" }; // 一年兩次的考試用「上/下」;三次以上的站在 site.json 設 sessionLabels
    return L[String(sess)] != null ? L[String(sess)] : "-" + sess;
  }
  function yearLabel(ys) {
    var p = String(ys).split("-");
    return p[0] + sessionLabel(p[1]);
  }
  window.Site = {
    tpl: tpl,
    here: here,
    subjectButtons: subjectButtons,
    yearLabel: yearLabel,
    sessionLabel: sessionLabel,
    fill: fill,
  };
})();

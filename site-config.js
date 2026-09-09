// 由 build.py 從 sites/nursing/site.json 生成,不要手改
window.SITE = {
  "id": "nursing",
  "name": "護理師國考互動筆記",
  "shortName": "護理師國考",
  "homeLabel": "護理師主頁",
  "description": "護理師國家考試互動筆記與歷屆試題練習",
  "brand": "ezpass",
  "examName": "護理師國考",
  "examShort": "護理師國考",
  "examMinutes": 60,
  "eyebrow": "EZPASS NURSING",
  "practiceName": "護理師國考練習本",
  "practiceIcon": "🩺",
  "heroArt": "nurseCap",
  "practiceDesc": "105~115 年歷屆 8,480 題 · 分科分年 · 狀態追蹤 (詳解陸續補上)",
  "domain": "nursing.ezpass-exam.com",
  "themeColor": "#f8f7f0",
  "aiRole": "護理師",
  "pdfHint": "(護理師歷年 PDF 資料夾,待補)",
  "nextExam": {
    "date": "2027-02-01",
    "note": "※ 暫填 · 精確日期以考選部公告為準"
  },
  "firebase": {
    "apiKey": "AIzaSyApomsj_lJxKaxW5gscsCMtJjowRBzZbgQ",
    "authDomain": "nursing.ezpass-exam.com",
    "databaseURL": "https://ezpass-nursing-default-rtdb.asia-southeast1.firebasedatabase.app",
    "projectId": "ezpass-nursing",
    "storageBucket": "ezpass-nursing.firebasestorage.app",
    "messagingSenderId": "784192508951",
    "appId": "1:784192508951:web:ecaeece496575a5e707852"
  },
  "subjects": [
    {
      "code": "nr1",
      "name": "基醫",
      "full": "基礎醫學",
      "emoji": "🧬",
      "color": "#0e7490",
      "accent": "#3b82f6",
      "bg": "#dbeafe",
      "fg": "#1d4ed8",
      "desc": "解剖・生理・病理・微免・藥理",
      "topics": [
        "解剖生理",
        "病理",
        "微免",
        "藥理",
        "其他"
      ]
    },
    {
      "code": "nr2",
      "name": "基護",
      "full": "基本護理學與護理行政",
      "emoji": "🩺",
      "color": "#7c3aed",
      "accent": "#7c3aed",
      "bg": "#ede9fe",
      "fg": "#5b21b6",
      "desc": "護理原理・技術・行政",
      "topics": [
        "護理原理",
        "護理技術",
        "護理行政",
        "倫理法規",
        "其他"
      ]
    },
    {
      "code": "nr3",
      "name": "內外",
      "full": "內外科護理學",
      "emoji": "❤️",
      "color": "#b91c1c",
      "accent": "#ef4444",
      "bg": "#fee2e2",
      "fg": "#991b1b",
      "desc": "內科・外科護理",
      "topics": [
        "心血管",
        "呼吸",
        "消化",
        "內分泌",
        "腎泌尿",
        "神經",
        "骨骼肌肉",
        "腫瘤",
        "其他"
      ]
    },
    {
      "code": "nr4",
      "name": "產兒",
      "full": "產科與兒科護理學",
      "emoji": "👶",
      "color": "#be185d",
      "accent": "#ec4899",
      "bg": "#fce7f3",
      "fg": "#9d174d",
      "desc": "產科・新生兒・兒科",
      "topics": [
        "產科",
        "新生兒",
        "兒科",
        "其他"
      ]
    },
    {
      "code": "nr5",
      "name": "精社",
      "full": "精神科與社區衛生護理學",
      "emoji": "🌱",
      "color": "#166534",
      "accent": "#16a34a",
      "bg": "#dcfce7",
      "fg": "#14532d",
      "desc": "精神科・社區衛生",
      "topics": [
        "精神科",
        "社區衛生",
        "長期照護",
        "其他"
      ]
    }
  ],
  "defaultSubject": "nr1",
  "primarySubject": "nr3",
  "years": [
    "105-1",
    "105-2",
    "106-1",
    "106-2",
    "107-1",
    "107-2",
    "108-1",
    "108-2",
    "109-1",
    "109-2",
    "110-1",
    "110-2",
    "111-1",
    "111-2",
    "112-1",
    "112-2",
    "112-3",
    "113-1",
    "113-2",
    "113-3",
    "114-1",
    "114-2",
    "114-3",
    "115-1",
    "115-2"
  ],
  "defaultYear": "115-2",
  "domains": [
    {
      "name": "解剖生理 Anatomy & Physiology",
      "emoji": "🧬",
      "color": "#a855f7",
      "subjects": [
        "nr1"
      ]
    },
    {
      "name": "病理與微免 Pathology & Micro",
      "emoji": "🔬",
      "color": "#9333ea",
      "subjects": [
        "nr1"
      ]
    },
    {
      "name": "藥理 Pharmacology",
      "emoji": "💊",
      "color": "#0891b2",
      "subjects": [
        "nr1"
      ]
    },
    {
      "name": "基本護理 Fundamentals",
      "emoji": "🩺",
      "color": "#7c3aed",
      "subjects": [
        "nr2"
      ]
    },
    {
      "name": "護理行政與倫理 Admin & Ethics",
      "emoji": "📋",
      "color": "#6b7280",
      "subjects": [
        "nr2"
      ]
    },
    {
      "name": "內外科護理 Medical-Surgical",
      "emoji": "❤️",
      "color": "#dc2626",
      "subjects": [
        "nr3"
      ]
    },
    {
      "name": "產科護理 Maternity",
      "emoji": "🤱",
      "color": "#ec4899",
      "subjects": [
        "nr4"
      ]
    },
    {
      "name": "兒科護理 Pediatrics",
      "emoji": "👶",
      "color": "#f59e0b",
      "subjects": [
        "nr4"
      ]
    },
    {
      "name": "精神科護理 Psychiatric",
      "emoji": "🧠",
      "color": "#0369a1",
      "subjects": [
        "nr5"
      ]
    },
    {
      "name": "社區衛生護理 Community Health",
      "emoji": "🌱",
      "color": "#16a34a",
      "subjects": [
        "nr5"
      ]
    },
    {
      "name": "其他 Other",
      "emoji": "📁",
      "color": "#9ca3af",
      "subjects": []
    }
  ],
  "domainBySubject": {
    "nr1": "解剖生理 Anatomy & Physiology",
    "nr2": "基本護理 Fundamentals",
    "nr3": "內外科護理 Medical-Surgical",
    "nr4": "產科護理 Maternity",
    "nr5": "精神科護理 Psychiatric"
  },
  "domainAliases": {},
  "topicCats": [],
  "ai": {
    "termsRule": "【用語守則(必須遵守，生成詳解也要)】\n            - 一律用繁體中文，絕對不要簡體字\n            - 用台灣臨床與護理教科書慣用語;若原文是簡體或大陸用語，自動換成台灣用語，不可保留原詞。\n            ",
    "termsRuleTag": "【用語守則",
    "termReplacements": [
      [
        "修复",
        "修復"
      ],
      [
        "关节",
        "關節"
      ],
      [
        "韧带",
        "韌帶"
      ],
      [
        "护理",
        "護理"
      ],
      [
        "静脉",
        "靜脈"
      ],
      [
        "动脉",
        "動脈"
      ],
      [
        "药物",
        "藥物"
      ],
      [
        "剂量",
        "劑量"
      ]
    ],
    "termsFixSummary": "- 簡體字 → 繁體字\n- 大陸用語 → 台灣護理慣用語",
    "noRefTopics": [],
    "noRefNote": "",
    "explExamples": "      【找對題】範例:\n      - **(A) 先評估意識與呼吸** ✓ 任何急症處置都以 ABC 為先，確認生命徵象才決定後續 → **這就是答案**\n      - **(B) 立刻給止痛藥** ✗ 未評估前給藥可能掩蓋症狀或造成呼吸抑制\n\n      【找錯題】範例:\n      - **(A) 低血鉀會使心電圖出現 U 波** ✓ 低血鉀典型表現為 T 波低平、U 波出現\n      - **(B) 高血鉀首選處置是補充鈣片口服** ✗ 高血鉀緊急處置為靜脈鈣劑、胰島素加葡萄糖等，口服鈣片無效 → **這就是答案**",
    "triggerExamples": "「高血鉀 → 心電圖 T 波高尖」「Digoxin 中毒 → 視覺黃綠光暈」"
  },
  "sw": {
    "precache": [],
    "dataFiles": []
  },
  "exampleQid": "nr3-115-2-3",
  "sessionLabels": {
    "1": "①",
    "2": "②",
    "3": "③"
  }
};

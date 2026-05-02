import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const DIST_DIR = path.join(__dirname, "dist");
const INDEX_PATH = path.join(DIST_DIR, "index.html");

loadEnvFile();

const THINGSPEAK_CHANNEL_ID = process.env.THINGSPEAK_CHANNEL_ID || "";
const THINGSPEAK_READ_API_KEY = process.env.THINGSPEAK_READ_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const LLM_PROVIDER = process.env.LLM_PROVIDER || "ollama";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "tinyllama";
const THINGSPEAK_FIELDS = {
  hr: Number(process.env.THINGSPEAK_FIELD_HR || 1),
  hrv: Number(process.env.THINGSPEAK_FIELD_HRV || 2),
  eda: Number(process.env.THINGSPEAK_FIELD_EDA || 3)
};
const STATIC_MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
}

const doctorUser = {
  id: "doctor-1",
  name: "Ananya Krishnan",
  username: "Ananya Krishnan",
  password: "doc123",
  role: "doctor",
  specialty: "Psychiatry"
};

const starterPatients = [];

const positiveWords = ["good", "fine", "better", "okay", "ok", "calm", "relaxed", "happy", "great", "peaceful", "steady"];
const negativeWords = ["bad", "sad", "stress", "stressed", "anxious", "anxiety", "worried", "panic", "tired", "overwhelmed", "angry", "upset", "down", "exhausted", "burnout", "nervous", "afraid", "hopeless", "worthless", "depressed", "depression", "fat", "fatter", "binge", "die", "dying", "suicide", "kill myself", "end it"];
const keywordBuckets = {
  exam: ["exam", "test", "quiz"],
  meeting: ["meeting", "presentation", "call"],
  fight: ["fight", "argument", "conflict"],
  deadline: ["deadline", "submission", "due", "project"],
  sleep: ["sleep", "insomnia", "awake", "rest"],
  work: ["work", "office", "manager", "boss"],
  study: ["study", "class", "assignment", "college"],
  body_image: ["fat", "fatter", "weight", "body", "looks", "appearance"],
  eating: ["eat so much", "overeating", "binge", "binge eating", "snacking", "craving", "food"],
  self_harm: ["i want to die", "want to die", "kill myself", "end my life", "suicide", "hurt myself", "self harm"]
};
const distortions = [
  { type: "overgeneralization", patterns: ["always", "never", "everything is going wrong", "nothing works"] },
  { type: "negative bias", patterns: ["i always fail", "i am a failure", "i can't do anything right"] }
];

function isoNow() {
  return new Date().toISOString();
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(text);
}

function serveStaticFile(res, filePath) {
  try {
    const body = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": STATIC_MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
    });
    res.end(body);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function tryServeFrontend(req, res, pathname) {
  if (req.method !== "GET" || !fs.existsSync(INDEX_PATH)) return false;

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const normalizedPath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(DIST_DIR, normalizedPath);

  if (filePath.startsWith(DIST_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    serveStaticFile(res, filePath);
    return true;
  }

  serveStaticFile(res, INDEX_PATH);
  return true;
}


function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function createToken(payload) {
  const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.mock-signature`;
}

function getSession(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireSession(req, res, role = null) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: "Unauthorized" });
    return null;
  }
  if (role && session.role !== role) {
    json(res, 403, { error: "Forbidden" });
    return null;
  }
  return session;
}

function defaultDb() {
  return {
    doctorUser,
    patients: starterPatients.map(patient => ({ ...patient })),
    notesByPatient: {},
    messagesByPatient: {},
    chats: {},
    analyses: {},
    sensorHistory: {},
    summaries: {}
  };
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDb(), null, 2));
  }
}

function loadDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function createAvatar(name) {
  return String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "PT";
}

function isStarterPrompt(text) {
  return [
    "How are you feeling right now? You can tell me briefly, and I’ll combine that with your recent vitals.",
    "Let’s start fresh. How are you feeling right now? You can also tell me a little about what has been on your mind lately."
  ].includes(String(text || "").trim());
}

function sanitizeDb(rawDb) {
  const nextDb = {
    doctorUser: rawDb?.doctorUser || doctorUser,
    patients: Array.isArray(rawDb?.patients) ? rawDb.patients.map(patient => ({ ...patient })) : [],
    notesByPatient: rawDb?.notesByPatient && typeof rawDb.notesByPatient === "object" ? rawDb.notesByPatient : {},
    messagesByPatient: rawDb?.messagesByPatient && typeof rawDb.messagesByPatient === "object" ? rawDb.messagesByPatient : {},
    chats: rawDb?.chats && typeof rawDb.chats === "object" ? rawDb.chats : {},
    analyses: rawDb?.analyses && typeof rawDb.analyses === "object" ? rawDb.analyses : {},
    sensorHistory: rawDb?.sensorHistory && typeof rawDb.sensorHistory === "object" ? rawDb.sensorHistory : {},
    summaries: rawDb?.summaries && typeof rawDb.summaries === "object" ? rawDb.summaries : {}
  };

  const initialPatientIds = new Set(
    nextDb.patients.map(patient => patient.id).filter(Boolean)
  );

  nextDb.patients = nextDb.patients.filter(patient => {
    delete patient.mockThingSpeakMode;
    patient.avatar = patient.avatar || createAvatar(patient.name);
    patient.mood = toNumberOrNull(patient.mood);
    patient.sleep = toNumberOrNull(patient.sleep);
    patient.streak = Number.isFinite(Number(patient.streak)) ? Number(patient.streak) : 0;
    patient.hr = toNumberOrNull(patient.hr);
    patient.hrv = toNumberOrNull(patient.hrv);
    patient.eda = toNumberOrNull(patient.eda);

    const history = Array.isArray(nextDb.sensorHistory[patient.id]) ? nextDb.sensorHistory[patient.id] : [];
    const realHistory = history
      .filter(entry => entry && entry.source !== "seed" && entry.source !== "thingspeak-mock")
      .map(entry => ({
        ...entry,
        hr: toNumberOrNull(entry.hr),
        hrv: toNumberOrNull(entry.hrv),
        eda: toNumberOrNull(entry.eda)
      }))
      .filter(entry => entry.hr !== null && entry.hrv !== null && entry.eda !== null);
    nextDb.sensorHistory[patient.id] = realHistory;

    const chats = Array.isArray(nextDb.chats[patient.id]) ? nextDb.chats[patient.id] : [];
    const nonStarterChats = chats.filter(message => !isStarterPrompt(message?.text));
    const analyses = Array.isArray(nextDb.analyses[patient.id]) ? nextDb.analyses[patient.id] : [];
    const notes = Array.isArray(nextDb.notesByPatient[patient.id]) ? nextDb.notesByPatient[patient.id] : [];
    const messages = Array.isArray(nextDb.messagesByPatient[patient.id]) ? nextDb.messagesByPatient[patient.id] : [];

    const looksLikeUntouchedSeedPatient =
      nonStarterChats.length === 0 &&
      analyses.length === 0 &&
      notes.length === 0 &&
      messages.length === 0 &&
      realHistory.length === 0 &&
      ["patient-1", "patient-2", "patient-3"].includes(patient.id);

    if (looksLikeUntouchedSeedPatient) {
      delete nextDb.sensorHistory[patient.id];
      delete nextDb.chats[patient.id];
      delete nextDb.analyses[patient.id];
      delete nextDb.notesByPatient[patient.id];
      delete nextDb.messagesByPatient[patient.id];
      delete nextDb.summaries[patient.id];
      return false;
    }

    const latestRealVitals = realHistory[0] || null;
    patient.hr = latestRealVitals?.hr ?? patient.hr;
    patient.hrv = latestRealVitals?.hrv ?? patient.hrv;
    patient.eda = latestRealVitals?.eda ?? patient.eda;
    if (!latestRealVitals) {
      patient.hr = null;
      patient.hrv = null;
      patient.eda = null;
    }

    nextDb.notesByPatient[patient.id] = notes.filter(
      entry => entry?.note !== "Patient reports steadier mood this week. Continue current coping exercises and evening wind-down routine."
    );
    nextDb.messagesByPatient[patient.id] = messages.filter(
      entry => entry?.content !== "You have been doing well with daily check-ins. Keep prioritizing sleep this week."
    );

    return true;
  });

  const validPatientIds = new Set(nextDb.patients.map(patient => patient.id));
  for (const collection of [nextDb.notesByPatient, nextDb.messagesByPatient, nextDb.chats, nextDb.analyses, nextDb.sensorHistory, nextDb.summaries]) {
    for (const key of Object.keys(collection)) {
      if (!validPatientIds.has(key)) delete collection[key];
    }
  }

  return {
    db: nextDb,
    changed:
      nextDb.patients.length !== initialPatientIds.size ||
      JSON.stringify(rawDb) !== JSON.stringify(nextDb)
  };
}

const sanitizedDb = sanitizeDb(loadDb());
let db = sanitizedDb.db;
if (sanitizedDb.changed) saveDb(db);

function getPatientById(patientId) {
  return db.patients.find(patient => patient.id === patientId) || null;
}

function getSafePatient(patient) {
  if (!patient) return null;
  const { password, ...safePatient } = patient;
  return safePatient;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function displayValue(value, suffix = "") {
  return Number.isFinite(value) ? `${value}${suffix}` : "N/A";
}

function getPromptSlot(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "night";
}

function getPromptText(slot) {
  if (slot === "morning") return "How did you sleep, and how does your body feel this morning?";
  if (slot === "afternoon") return "How is your day going so far? Anything tense or draining?";
  return "Anything stressful or heavy from today that is still sitting with you tonight?";
}

function normalizeText(text) {
  return String(text || "").toLowerCase().trim();
}

function shouldResetChatIntent(text) {
  const lower = normalizeText(text);
  return [
    /start new chat/,
    /\bnew chat\b/,
    /reset chat/,
    /clear chat/,
    /forget everything/,
    /start over/,
    /restart conversation/,
    /begin again/,
    /fresh start/
  ].some(pattern => pattern.test(lower));
}

function detectSentiment(text) {
  const lower = normalizeText(text);
  let score = 0;
  if (/(not okay|not ok|not good|not fine|not better)/.test(lower)) score -= 2;
  for (const word of positiveWords) if (lower.includes(word)) score += 1;
  for (const word of negativeWords) if (lower.includes(word)) score -= 1;
  if (/(i want to die|kill myself|end my life|suicide|hurt myself|self harm)/.test(lower)) score -= 6;
  if (score >= 1) return { label: "positive", score };
  if (score <= -2) return { label: "negative", score };
  return { label: "neutral", score };
}

function detectRiskSignals(text) {
  const lower = normalizeText(text);
  return {
    crisis: /(i want to die|kill myself|end my life|suicide|hurt myself|self harm)/.test(lower),
    hopeless: /(hopeless|no point|can't go on|give up|worthless)/.test(lower)
  };
}

function detectEmotion(text) {
  const lower = normalizeText(text);
  if (/(i want to die|kill myself|end my life|suicide|hurt myself|self harm)/.test(lower)) return "crisis";
  if (/(not okay|not ok|depressed|depression|empty|numb)/.test(lower)) return "sadness";
  if (/(stress|stressed|overwhelm|deadline|panic|tense)/.test(lower)) return "stress";
  if (/(anx|nervous|worried|fear|afraid)/.test(lower)) return "anxiety";
  if (/(sad|down|lonely|empty|cry)/.test(lower)) return "sadness";
  if (/(fat|fatter|weight|overeat|eat so much|binge|body)/.test(lower)) return "stress";
  if (/(calm|peaceful|steady|relaxed|fine|okay|happy|better|good)/.test(lower)) return "calm";
  return "neutral";
}

function detectKeywords(text) {
  const lower = normalizeText(text);
  return Object.entries(keywordBuckets)
    .filter(([, patterns]) => patterns.some(pattern => lower.includes(pattern)))
    .map(([label]) => label);
}

function detectDistortions(text) {
  const lower = normalizeText(text);
  return distortions
    .filter(entry => entry.patterns.some(pattern => lower.includes(pattern)))
    .map(entry => entry.type);
}

function analyzeText(text) {
  const sentiment = detectSentiment(text);
  const emotion = detectEmotion(text);
  const keywords = detectKeywords(text);
  const distortionsFound = detectDistortions(text);
  const riskSignals = detectRiskSignals(text);
  return {
    sentiment: sentiment.label,
    sentimentScore: sentiment.score,
    emotion,
    keywords,
    distortions: distortionsFound,
    riskSignals
  };
}

function computeFusion(patient, vitals, analysis) {
  let score = 0;

  if (Number.isFinite(vitals?.hr) && vitals.hr >= 95) score += 2;
  else if (Number.isFinite(vitals?.hr) && vitals.hr >= 85) score += 1;

  if (Number.isFinite(vitals?.hrv) && vitals.hrv <= 40) score += 2;
  else if (Number.isFinite(vitals?.hrv) && vitals.hrv <= 52) score += 1;

  if (Number.isFinite(vitals?.eda) && vitals.eda >= 5) score += 2;
  else if (Number.isFinite(vitals?.eda) && vitals.eda >= 3.8) score += 1;

  if (analysis.sentiment === "negative") score += 2;
  else if (analysis.sentiment === "neutral") score += 1;

  if (["stress", "anxiety", "sadness"].includes(analysis.emotion)) score += 1;
  if (analysis.emotion === "crisis") score += 5;
  if (analysis.keywords.length > 0) score += 1;
  if (analysis.distortions.length > 0) score += 1;
  if (analysis.riskSignals.crisis) score += 5;
  if (analysis.riskSignals.hopeless) score += 2;

  const hasVitals = Number.isFinite(vitals?.hr) && Number.isFinite(vitals?.hrv) && Number.isFinite(vitals?.eda);
  const hiddenStress = hasVitals && (analysis.sentiment === "positive" || analysis.emotion === "calm") && vitals.hrv < 52 && vitals.hr > 85;
  const emotionalStressWithoutPhysical = hasVitals && analysis.sentiment === "negative" && vitals.hrv >= 55 && vitals.hr < 85;
  const alignedHighStress = hasVitals && analysis.sentiment === "negative" && vitals.hrv < 52;
  const crisisDetected = analysis.riskSignals.crisis;

  let discrepancy = "aligned";
  if (crisisDetected) discrepancy = "crisis";
  else if (hiddenStress) discrepancy = "hidden_stress";
  else if (emotionalStressWithoutPhysical) discrepancy = "emotional_without_physical";
  else if (alignedHighStress) discrepancy = "high_stress";

  let level = "low";
  if (crisisDetected || score >= 7) level = "high";
  else if (score >= 4) level = "medium";

  const insight =
    discrepancy === "crisis"
      ? "The message contains direct self-harm or suicide language and needs urgent follow-up."
      : discrepancy === "hidden_stress"
      ? "Your words sound fairly okay, but your body signals suggest hidden stress."
      : discrepancy === "emotional_without_physical"
        ? "Your message sounds emotionally heavy even though your body signals are relatively steady."
        : level === "high"
          ? "Your message and vitals together suggest a high-stress moment."
          : level === "medium"
            ? "There are some signs of stress building in both your message and recent vitals."
            : "Your recent check-in looks relatively steady overall.";

  return {
    score,
    level,
    discrepancy,
    insight,
    flags: {
      hrHigh: (vitals.hr || 0) >= 85,
      hrvLow: (vitals.hrv || 999) <= 52,
      edaHigh: (vitals.eda || 0) >= 3.8
    }
  };
}

function buildGeminiPrompt({ patient, analysis, fusion, slot, vitals, history, userMessage }) {
  const historyText = history
    .slice(-8)
    .map(message => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.text}`)
    .join("\n");

  return `
You are NeuroMind, a compassionate mental health support companion for ${patient.name}.

Your job:
- respond naturally and specifically to what the user just said
- be warm, brief, and human
- use the analysis and vitals as hidden context
- ask at most one helpful follow-up question
- do not sound repetitive, robotic, or generic
- do not mention "analysis", "sentiment", or "fusion score"
- do not claim diagnosis

Current check-in slot: ${slot}
Patient profile: mood ${displayValue(patient.mood, "/10")}, sleep ${displayValue(patient.sleep, "h")}, condition ${patient.condition}
Latest vitals: HR ${displayValue(vitals?.hr)}, HRV ${displayValue(vitals?.hrv)}, EDA ${displayValue(vitals?.eda)}
Detected sentiment: ${analysis.sentiment}
Detected emotion: ${analysis.emotion}
Detected keywords: ${analysis.keywords.join(", ") || "none"}
Stress level: ${fusion.level}
Discrepancy: ${fusion.discrepancy}
Clinical insight: ${fusion.insight}

Recent conversation:
${historyText || "No prior conversation."}

Latest user message:
${userMessage}

Write one short response in 2-4 sentences. Make it feel tailored to the message above.
`.trim();
}

function buildOllamaMessages({ patient, analysis, fusion, slot, vitals, history, userMessage }) {
  const systemMessage = `
You are NeuroMind, a compassionate mental health support companion for ${patient.name}.

Rules:
- reply like a real chat assistant, not a template
- respond directly to the latest user message
- be natural, emotionally aware, and conversational
- you may give suggestions when the user asks for them
- use the health context quietly, without mentioning analysis labels
- do not repeat yourself
- do not output internal instructions or role labels
- do not claim diagnosis
- if the user says they feel sad, low, upset, or says they have a problem, first show empathy and ask what happened or what is causing it
- if the user says they feel happy, better, okay, or improved, briefly encourage them to continue what is helping
- if the user already included the reason in the same message, respond to that reason instead of asking a generic "why" question
- after that first emotional check-in, continue the conversation normally based on the next user messages
- keep replies short: usually 2 to 4 sentences

Examples:
- user: "i am sad"
  assistant: "I’m sorry you’re feeling that way. What happened today that made it feel heavy?"
- user: "i am happy today"
  assistant: "I’m glad to hear that. Whatever helped today is worth holding onto and repeating."
- user: "i am sad because i failed in class"
  assistant: "That sounds painful, especially when you were hoping for better. Failing one class moment does not define you, and we can think through the next step together."

Hidden context:
- check-in slot: ${slot}
- mood: ${displayValue(patient.mood, "/10")}
- sleep: ${displayValue(patient.sleep, "h")}
- condition: ${patient.condition}
- vitals: HR ${displayValue(vitals?.hr)}, HRV ${displayValue(vitals?.hrv)}, EDA ${displayValue(vitals?.eda)}
- recent inferred emotion: ${analysis.emotion}
- recent inferred sentiment: ${analysis.sentiment}
- recent stress level: ${fusion.level}
- recent context note: ${fusion.insight}
`.trim();

  const transcript = history
    .filter(message => message.role === "user")
    .slice(-6)
    .map(message => ({
      role: "user",
      content: message.text
    }));

  return [
    { role: "system", content: systemMessage },
    ...transcript,
    { role: "user", content: userMessage }
  ];
}

function sanitizeOllamaReply(text, userMessage) {
  if (!text) return null;
  let reply = text.trim();

  reply = reply.replace(/^assistant:\s*/i, "").trim();
  reply = reply.replace(/^neuromind:\s*/i, "").trim();

  const lower = reply.toLowerCase();
  const promptEchoMarkers = [
    "you are neuromind",
    "your job:",
    "rules:",
    "hidden context:",
    "latest user message:",
    "recent conversation:",
    "context notes",
    "recent inferred",
    "examples:",
    "user:",
    "assistant:",
    "vital signs",
    "emotional state",
    "high-stress moment"
  ];

  if (promptEchoMarkers.some(marker => lower.includes(marker))) {
    return null;
  }

  if (userMessage && lower === userMessage.trim().toLowerCase()) {
    return null;
  }

  return reply;
}

function userAlreadyGaveReason(text) {
  const lower = normalizeText(text);
  return /\b(because|since|due to|after|when|feels like|i failed|it happened|the reason)\b/.test(lower) || lower.split(/\s+/).length >= 10;
}

function buildBehavioralFallback(context) {
  const { analysis, userMessage } = context;
  const hasReason = userAlreadyGaveReason(userMessage);

  if (analysis.riskSignals.crisis) {
    return "I’m really glad you told me. If you feel unsafe or might act on this, contact emergency help or a crisis line right now and tell a trusted person near you immediately.";
  }

  if ((analysis.emotion === "sadness" || analysis.sentiment === "negative") && !hasReason) {
    return "I’m sorry you’re feeling this way. What happened, or what’s making it feel heavy right now?";
  }

  if ((analysis.emotion === "sadness" || analysis.sentiment === "negative") && hasReason) {
    return "That sounds really hard, and it makes sense that it’s affecting you. What part of this feels most difficult for you right now?";
  }

  if ((analysis.sentiment === "positive" || analysis.emotion === "calm") && !hasReason) {
    return "I’m glad to hear that. Whatever helped today is worth holding onto and continuing.";
  }

  if ((analysis.sentiment === "positive" || analysis.emotion === "calm") && hasReason) {
    return "I’m glad to hear that, and it sounds like something is working for you. Keep leaning into what helped today and notice if you can repeat it tomorrow too.";
  }

  if (/problem/.test(normalizeText(userMessage)) && !hasReason) {
    return "I’m here with you. Tell me a little more about the problem so I can respond in a useful way.";
  }

  return "I’m here with you. Tell me a little more about what’s going on right now.";
}

function isLowQualityAssistantMessage(text) {
  const lower = normalizeText(text || "");
  if (!lower) return false;
  return [
    "i apologize for my previous message",
    "here are some tips",
    "practice gratitude",
    "practice mindfulness meditation",
    "reach out for support",
    "your job:",
    "hidden context:"
  ].some(marker => lower.includes(marker));
}

async function generateGeminiReply(context) {
  if (!GEMINI_API_KEY) return null;

  const prompt = buildGeminiPrompt(context);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.8,
        topP: 0.9,
        maxOutputTokens: 180
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
  return text || null;
}

async function generateOllamaReply(context) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: buildOllamaMessages(context),
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 180
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return sanitizeOllamaReply(data?.message?.content, context.userMessage);
}

async function generateModelReply(context) {
  if (LLM_PROVIDER === "ollama") {
    return generateOllamaReply(context);
  }
  if (LLM_PROVIDER === "gemini") {
    return generateGeminiReply(context);
  }
  if (LLM_PROVIDER === "auto") {
    try {
      return await generateOllamaReply(context);
    } catch (error) {
      console.error(error);
    }
    return generateGeminiReply(context);
  }
  return null;
}

function trimList(list, maxItems) {
  if (list.length > maxItems) list.splice(maxItems);
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function isSameDay(iso, day = todayKey()) {
  return String(iso || "").startsWith(day);
}

function updatePatientFromAnalysis(patient, analysis, vitals) {
  const moodDelta = analysis.sentiment === "positive" ? 1 : analysis.sentiment === "negative" ? -1 : 0;
  const currentMood = Number.isFinite(patient.mood) ? patient.mood : 6;
  patient.mood = clamp(Math.round(currentMood + moodDelta), 1, 10);
  if (Number.isFinite(vitals?.hr)) patient.hr = vitals.hr;
  if (Number.isFinite(vitals?.hrv)) patient.hrv = vitals.hrv;
  if (Number.isFinite(vitals?.eda)) patient.eda = vitals.eda;
}

function recordSensor(patientId, vitals) {
  db.sensorHistory[patientId] ||= [];
  const latest = db.sensorHistory[patientId][0];
  if (
    latest &&
    latest.timestamp === vitals.timestamp &&
    latest.source === vitals.source &&
    latest.hr === vitals.hr &&
    latest.hrv === vitals.hrv &&
    latest.eda === vitals.eda
  ) {
    return latest;
  }
  const entry = { id: randomUUID(), ...vitals };
  db.sensorHistory[patientId].unshift(entry);
  trimList(db.sensorHistory[patientId], 1000);
  return entry;
}

async function fetchThingSpeakLatest() {
  if (!THINGSPEAK_CHANNEL_ID) return null;

  const url = `https://api.thingspeak.com/channels/${THINGSPEAK_CHANNEL_ID}/feeds/last.json${THINGSPEAK_READ_API_KEY ? `?api_key=${THINGSPEAK_READ_API_KEY}` : ""}`;

  return new Promise(resolve => {
    const request = https.get(url, { timeout: 4000 }, response => {
      let body = "";
      response.on("data", chunk => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          const payload = JSON.parse(body);
          const hr = Number(payload[`field${THINGSPEAK_FIELDS.hr}`]);
          const hrv = Number(payload[`field${THINGSPEAK_FIELDS.hrv}`]);
          const eda = Number(payload[`field${THINGSPEAK_FIELDS.eda}`]);
          if (!Number.isFinite(hr) || !Number.isFinite(hrv) || !Number.isFinite(eda)) {
            resolve(null);
            return;
          }
          resolve({
            hr,
            hrv,
            eda,
            timestamp: payload.created_at || isoNow(),
            source: "thingspeak"
          });
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
  });
}

async function latestVitalsForPatient(patientId) {
  const patient = getPatientById(patientId);
  if (!patient) return null;

  const thingSpeak = await fetchThingSpeakLatest();
  if (thingSpeak) {
    const recorded = recordSensor(patientId, thingSpeak);
    updatePatientFromAnalysis(patient, { sentiment: "neutral" }, recorded);
    saveDb(db);
    return recorded;
  }

  return db.sensorHistory[patientId]?.[0] || null;
}

function buildDailySummary(patientId) {
  const patient = getPatientById(patientId);
  const todaysAnalyses = (db.analyses[patientId] || []).filter(entry => isSameDay(entry.timestamp));
  const latestVitals = db.sensorHistory[patientId]?.[0] || null;

  const negatives = todaysAnalyses.filter(entry => entry.sentiment === "negative").length;
  const keywords = [...new Set(todaysAnalyses.flatMap(entry => entry.keywords))];
  const topDiscrepancy = todaysAnalyses.find(entry => entry.discrepancy !== "aligned");
  const crisisCount = todaysAnalyses.filter(entry => entry.riskSignals?.crisis).length;
  const averageStress = todaysAnalyses.length
    ? Math.round(todaysAnalyses.reduce((sum, entry) => sum + entry.stressScore, 0) / todaysAnalyses.length)
    : null;

  const lines = [];
  lines.push(`${patient.name} has completed ${todaysAnalyses.length} check-in${todaysAnalyses.length === 1 ? "" : "s"} today.`);

  if (averageStress !== null) {
    lines.push(`Average fusion stress score today is ${averageStress}/10.`);
  }
  if (negatives > 0) {
    lines.push(`${negatives} message${negatives === 1 ? "" : "s"} carried negative sentiment.`);
  }
  if (keywords.length > 0) {
    lines.push(`Common triggers mentioned: ${keywords.join(", ")}.`);
  }
  if (topDiscrepancy) {
    lines.push(`Most important mismatch: ${topDiscrepancy.discrepancy.replaceAll("_", " ")}.`);
  }
  if (crisisCount > 0) {
    lines.push(`Urgent safety language was detected ${crisisCount} time${crisisCount === 1 ? "" : "s"} today.`);
  }
  if (latestVitals) {
    lines.push(`Latest vitals: HR ${latestVitals.hr}, HRV ${latestVitals.hrv}, EDA ${latestVitals.eda}.`);
  }

  const summary = {
    date: todayKey(),
    text: lines.join(" "),
    averageStress,
    negatives,
    crisisCount,
    keywords,
    latestVitals
  };

  db.summaries[patientId] = summary;
  return summary;
}

function deriveCheckInStreak(patientId) {
  const daySet = new Set([
    ...(db.analyses[patientId] || []).map(entry => String(entry.timestamp || "").slice(0, 10)),
    ...(db.chats[patientId] || [])
      .filter(entry => entry?.role === "user")
      .map(entry => String(entry.time || "").slice(0, 10))
  ].filter(Boolean));

  if (!daySet.size) return 0;

  const sortedDays = [...daySet].sort().reverse();
  let streak = 0;
  let cursor = new Date(`${sortedDays[0]}T00:00:00.000Z`);

  for (const day of sortedDays) {
    const dayIso = cursor.toISOString().slice(0, 10);
    if (day !== dayIso) break;
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return streak;
}

function deriveMoodScore(patientId) {
  const recentAnalyses = (db.analyses[patientId] || []).slice(0, 8);
  if (!recentAnalyses.length) return null;

  let weightedTotal = 0;
  let totalWeight = 0;

  recentAnalyses.forEach((entry, index) => {
    const weight = recentAnalyses.length - index;
    weightedTotal += (entry.sentimentScore || 0) * weight;
    totalWeight += weight;
  });

  const weightedAverage = totalWeight ? weightedTotal / totalWeight : 0;
  return clamp(Math.round(5 + weightedAverage * 1.5), 1, 10);
}

function getDerivedPatientProfile(patient) {
  if (!patient) return null;
  return {
    ...patient,
    mood: deriveMoodScore(patient.id) ?? patient.mood,
    streak: deriveCheckInStreak(patient.id)
  };
}

function getPatientInsight(patientId) {
  const rawPatient = getPatientById(patientId);
  if (!rawPatient) return null;
  const patient = getDerivedPatientProfile(rawPatient);
  const latestAnalysis = db.analyses[patientId]?.[0] || null;
  const summary = db.summaries[patientId] || buildDailySummary(patientId);
  const latestVitals = db.sensorHistory[patientId]?.[0] || null;
  const sensorHistory = (db.sensorHistory[patientId] || []).slice(0, 500).reverse();
  const analysisHistory = (db.analyses[patientId] || []).slice(0, 20).reverse();
  const comparisons = getChatVitalsComparisonEntries(patientId);

  const discrepancies = (db.analyses[patientId] || [])
    .filter(entry => entry.discrepancy !== "aligned")
    .slice(0, 4)
    .map(entry => ({
      severity: entry.discrepancy === "crisis" || entry.stressLevel === "high" ? "high" : entry.discrepancy === "hidden_stress" ? "medium" : "low",
      title:
        entry.discrepancy === "crisis"
          ? "Urgent safety language detected"
          : entry.discrepancy === "hidden_stress"
          ? "Possible hidden stress"
          : entry.discrepancy === "emotional_without_physical"
            ? "Emotional strain without strong physical activation"
            : "Stress markers aligned across chat and vitals",
      desc: entry.insight,
      time: new Date(entry.timestamp).toLocaleString(),
      confidence: `${70 + Math.min(entry.stressScore, 3) * 8}%`
    }));

  return {
    patient: getSafePatient(patient),
    latestAnalysis,
    latestVitals,
    dailySummary: summary,
    discrepancies,
    comparisons,
    sensorHistory,
    analysisHistory
  };
}

function getPatientOverview(patient) {
  const insight = getPatientInsight(patient.id);
  return {
    ...getSafePatient(getDerivedPatientProfile(patient)),
    latestStressLevel: insight?.latestAnalysis?.stressLevel || "low",
    latestStressScore: insight?.latestAnalysis?.stressScore || 0,
    lastSentiment: insight?.latestAnalysis?.sentiment || "neutral",
    dailySummary: insight?.dailySummary?.text || ""
  };
}

function getRecentChatMessages(patientId) {
  return (db.chats[patientId] || [])
    .filter(message => message.role !== "assistant" || !isLowQualityAssistantMessage(message.text))
    .slice(0, 12)
    .reverse()
    .map(message => ({
      role: message.role,
      text: message.text,
      time: new Date(message.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    }));
}

function formatVitalsSnapshot(vitals) {
  if (!vitals) return "No nearby vitals available";
  return `HR ${displayValue(vitals.hr)}, HRV ${displayValue(vitals.hrv)}, EDA ${displayValue(vitals.eda)}`;
}

function getNearestSensorReading(patientId, timestamp) {
  const target = new Date(timestamp).getTime();
  if (!Number.isFinite(target)) return null;
  const history = db.sensorHistory[patientId] || [];
  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const entry of history) {
    const time = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(time)) continue;
    const delta = Math.abs(time - target);
    if (delta < bestDelta) {
      best = entry;
      bestDelta = delta;
    }
  }

  return best;
}

function findAssistantReplyNear(patientId, timestamp) {
  const target = new Date(timestamp).getTime();
  if (!Number.isFinite(target)) return null;
  const chats = db.chats[patientId] || [];
  const assistantMessages = chats
    .filter(entry => entry?.role === "assistant" && !isStarterPrompt(entry.text))
    .map(entry => ({
      ...entry,
      timeMs: new Date(entry.time).getTime()
    }))
    .filter(entry => Number.isFinite(entry.timeMs))
    .sort((a, b) => a.timeMs - b.timeMs);

  for (const message of assistantMessages) {
    if (Math.abs(message.timeMs - target) <= 60 * 1000) {
      return message;
    }
  }

  return null;
}

function summarizeTriggerFromAnalysis(analysis) {
  if (!analysis) return "No clear trigger was named";
  if (analysis.riskSignals?.crisis) return "direct self-harm or suicide language";
  if (analysis.keywords?.length) {
    const labels = {
      exam: "exam or test pressure",
      meeting: "meeting or presentation stress",
      fight: "interpersonal conflict",
      deadline: "deadline or submission pressure",
      sleep: "sleep-related strain",
      work: "work-related stress",
      study: "study or academic pressure",
      body_image: "body-image concern",
      eating: "eating-related distress",
      self_harm: "self-harm thoughts"
    };
    return analysis.keywords.map(keyword => labels[keyword] || keyword).join(", ");
  }
  if (analysis.emotion === "sadness") return "low mood or loneliness without a clearly stated cause";
  if (analysis.emotion === "anxiety") return "anxiety without a clearly stated cause";
  if (analysis.emotion === "stress") return "general stress without a clearly stated trigger";
  return "No clear trigger was named";
}

function summarizePatientResponseStyle(text, analysis) {
  const lower = normalizeText(text);
  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  if (analysis?.riskSignals?.crisis) return "The patient answered directly with urgent safety language.";
  if (/(motivate me|help me|what should i do|advice)/.test(lower)) return "The patient asked directly for support or guidance.";
  if (/(lonely|alone|depressed|sad|overwhelmed|anxious|stress)/.test(lower) && wordCount <= 8) {
    return "The patient acknowledged distress but answered briefly, with limited detail.";
  }
  if (/(because|due to|after|since)/.test(lower) || wordCount >= 12) {
    return "The patient gave a more open response and shared some context for the distress.";
  }
  if (wordCount <= 3) return "The patient responded minimally, giving very little emotional detail.";
  return "The patient gave a short but emotionally relevant response.";
}

function summarizeAssistantReply(text) {
  const lower = normalizeText(text);
  if (!lower) return "No assistant reply was recorded alongside this moment.";
  if (/(what happened|what's making|tell me more|can you tell me more)/.test(lower)) {
    return "The assistant responded with empathy and asked the patient to elaborate on the cause.";
  }
  if (/(contact emergency help|crisis line|trusted person)/.test(lower)) {
    return "The assistant escalated to urgent safety guidance.";
  }
  if (/(glad to hear|keep leaning|worth holding onto)/.test(lower)) {
    return "The assistant reinforced what seemed to be helping.";
  }
  return "The assistant responded supportively and stayed focused on the patient's stated distress.";
}

function buildRelevantChatMoments(patientId, maxItems = 4) {
  const analyses = (db.analyses[patientId] || [])
    .filter(entry => entry?.text && !isStarterPrompt(entry.text))
    .slice(0, 12)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const scored = analyses.map(entry => {
    let score = 0;
    if (entry.riskSignals?.crisis) score += 10;
    if (entry.keywords?.length) score += 4;
    if (entry.stressLevel === "high") score += 3;
    if (entry.stressLevel === "medium") score += 2;
    if (entry.emotion && entry.emotion !== "neutral" && entry.emotion !== "calm") score += 2;
    if (entry.discrepancy && entry.discrepancy !== "aligned") score += 2;
    if ((entry.text || "").split(/\s+/).length >= 6) score += 1;
    return { ...entry, relevanceScore: score };
  });

  const selected = scored
    .filter(entry => entry.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, maxItems)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return selected.map(entry => {
    const vitals = getNearestSensorReading(patientId, entry.timestamp);
    const assistantReply = findAssistantReplyNear(patientId, entry.timestamp);
    return {
      time: new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      patientText: entry.text,
      triggerSummary: summarizeTriggerFromAnalysis(entry),
      responseStyle: summarizePatientResponseStyle(entry.text, entry),
      assistantSummary: summarizeAssistantReply(assistantReply?.text || ""),
      vitalsSummary: formatVitalsSnapshot(vitals),
      stressLevel: entry.stressLevel,
      stressScore: entry.stressScore
    };
  });
}

function getChatVitalsComparisonEntries(patientId, maxItems = 6) {
  const analyses = (db.analyses[patientId] || [])
    .filter(entry => entry?.text && !isStarterPrompt(entry.text))
    .slice(0, 12)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return analyses.slice(0, maxItems).map(entry => {
    const vitals = getNearestSensorReading(patientId, entry.timestamp);
    const patientTone =
      entry.riskSignals?.crisis
        ? "urgent safety language"
        : entry.sentiment === "negative" || ["sadness", "anxiety", "stress"].includes(entry.emotion)
          ? `${entry.emotion} / distressed tone`
          : entry.sentiment === "positive" || entry.emotion === "calm"
            ? "calmer / steadier tone"
            : "neutral or limited emotional disclosure";

    let bodyState = "no nearby physiological reading";
    if (vitals) {
      const flags = [
        vitals.hr >= 95 ? "high heart rate" : vitals.hr >= 85 ? "mildly elevated heart rate" : null,
        vitals.hrv <= 40 ? "low HRV" : vitals.hrv <= 52 ? "slightly reduced HRV" : null,
        vitals.eda >= 5 ? "high EDA arousal" : vitals.eda >= 3.8 ? "mildly raised EDA arousal" : null
      ].filter(Boolean);
      bodyState = flags.length ? flags.join(", ") : "relatively steady vitals";
    }

    let relation = "aligned";
    let relationTitle = "Chat and vitals were broadly aligned";
    let relationDetail = "The patient's language and physiology pointed in a similar direction at this moment.";

    if (entry.discrepancy === "hidden_stress") {
      relation = "hidden_stress";
      relationTitle = "Possible hidden stress";
      relationDetail = "The patient sounded calmer than the physiology suggested, which may reflect under-reporting or low awareness of bodily stress.";
    } else if (entry.discrepancy === "emotional_without_physical") {
      relation = "emotional_without_physical";
      relationTitle = "Emotional strain without strong physiological activation";
      relationDetail = "The patient described distress more strongly than the body-state markers showed at the same moment.";
    } else if (entry.discrepancy === "crisis") {
      relation = "crisis";
      relationTitle = "Urgent safety language";
      relationDetail = "The patient used direct safety-risk language and needs immediate clinical attention regardless of physiology.";
    } else if (entry.discrepancy === "high_stress") {
      relation = "high_stress";
      relationTitle = "High stress confirmed by both chat and vitals";
      relationDetail = "The patient's wording and physiological readings both pointed toward a high-stress moment.";
    }

    const severity =
      relation === "crisis" || relation === "high_stress"
        ? "high"
        : relation === "hidden_stress" || relation === "emotional_without_physical"
          ? "medium"
          : "low";

    return {
      id: entry.id,
      time: new Date(entry.timestamp).toLocaleString(),
      excerpt: entry.text,
      patientTone,
      bodyState,
      relation,
      relationTitle,
      relationDetail,
      severity,
      vitalsSummary: formatVitalsSnapshot(vitals),
      stressLevel: entry.stressLevel,
      stressScore: entry.stressScore
    };
  });
}

function buildRelevantChatSection(patientId) {
  const relevantChatMoments = buildRelevantChatMoments(patientId);
  if (!relevantChatMoments.length) {
    return "Relevant AI-Chat Discussion\nNo clinically relevant AI-chat moments have been recorded yet.";
  }

  return [
    "Relevant AI-Chat Discussion",
    ...relevantChatMoments.map(moment =>
      `- ${moment.time}: The patient said "${moment.patientText}". Likely stress theme: ${moment.triggerSummary}. ${moment.responseStyle} ${moment.assistantSummary} Nearby vitals at that time: ${moment.vitalsSummary}.`
    )
  ].join("\n");
}

function buildClinicalReport(patientId) {
  const patient = getDerivedPatientProfile(getPatientById(patientId));
  const insight = getPatientInsight(patientId);
  const latestAnalysis = insight?.latestAnalysis;
  const latestVitals = insight?.latestVitals;
  const summary = insight?.dailySummary;
  const todaysAnalyses = (db.analyses[patientId] || []).filter(entry => isSameDay(entry.timestamp)).slice().reverse();
  const recentAnalyses = todaysAnalyses.length ? todaysAnalyses : (db.analyses[patientId] || []).slice(0, 5);
  const recentNotes = db.notesByPatient[patientId] || [];
  const latestNote = recentNotes[0]?.note || null;
  const relevantChatMoments = buildRelevantChatMoments(patientId);
  const relevantChatSection = buildRelevantChatSection(patientId);
  const keywords = summary?.keywords?.length ? summary.keywords.join(", ") : "none clearly repeated";
  const discrepancyLabel = latestAnalysis?.discrepancy ? latestAnalysis.discrepancy.replaceAll("_", " ") : "not enough data";
  const triggerSummary = latestAnalysis?.keywords?.length ? latestAnalysis.keywords.join(", ") : keywords;
  const physiologicalSigns = latestVitals
    ? [
        latestVitals.hr >= 85 ? "elevated heart rate" : null,
        latestVitals.hrv <= 52 ? "reduced SpO2/HRV-side variability marker" : null,
        latestVitals.eda >= 3.8 ? "increased HRV/EDA-side arousal marker" : null
      ].filter(Boolean)
    : [];
  const topConcern =
    latestAnalysis?.riskSignals?.crisis
      ? "Urgent safety language detected in a recent check-in."
      : latestAnalysis?.stressLevel === "high"
        ? "Recent language and physiology suggest a high-stress period."
        : summary?.negatives
          ? "Recent check-ins contain recurring negative emotional content."
          : "No acute concern flagged in the latest check-in.";

  const interpretation = latestAnalysis
    ? [
        `Most recent chat tone appears ${latestAnalysis.sentiment} with a primary emotion of ${latestAnalysis.emotion}.`,
        `Current stress estimate is ${latestAnalysis.stressLevel} (${latestAnalysis.stressScore}/10).`,
        `Chat-to-vitals relationship is currently ${discrepancyLabel}.`,
        physiologicalSigns.length ? `Physiological stress signs include ${physiologicalSigns.join(", ")}.` : "There are no strong physiological stress markers in the latest reading."
      ].join(" ")
    : "Recent chat analysis is not yet available.";

  const vitalsLine = latestVitals
    ? `Latest vitals show HR ${latestVitals.hr}, HRV ${latestVitals.hrv}, and EDA ${latestVitals.eda}.`
    : "No recent vitals are available.";

  const emotionMaskingLine =
    latestAnalysis?.discrepancy === "hidden_stress"
      ? "The patient may be downplaying or hiding distress: language appears calmer than the body-state data suggests."
      : latestAnalysis?.discrepancy === "emotional_without_physical"
        ? "The patient is expressing distress more strongly in words than in simultaneous physiological activation."
        : latestAnalysis?.discrepancy === "high_stress"
          ? "Both the conversation and physiology point in the same direction, suggesting openly expressed stress rather than masked distress."
          : "There is no clear evidence in the latest sample that the patient is masking emotion relative to the vitals.";

  const causeLine =
    triggerSummary && triggerSummary !== "none clearly repeated"
      ? `Most likely immediate stress-related themes mentioned were: ${triggerSummary}.`
      : "A specific repeated trigger is not yet clear from the recent check-ins.";

  const hiddenStressCount = recentAnalyses.filter(entry => entry.discrepancy === "hidden_stress").length;
  const emotionalMismatchCount = recentAnalyses.filter(entry => entry.discrepancy === "emotional_without_physical").length;
  const alignedCount = recentAnalyses.filter(entry => entry.discrepancy === "aligned" || entry.discrepancy === "high_stress").length;
  const truthfulnessLine =
    !recentAnalyses.length
      ? "There are not enough recent check-ins yet to judge whether the patient is openly expressing emotion versus masking it."
      : hiddenStressCount >= 2
        ? "Across recent chats, the patient often sounds calmer than the physiology suggests, which may indicate hidden stress or emotional masking rather than fully open emotional reporting."
        : emotionalMismatchCount >= 2
          ? "Across recent chats, the patient is expressing distress more strongly in words than the body-state markers show at the same moment."
          : alignedCount >= Math.max(1, recentAnalyses.length - 1)
            ? "Across recent chats, the patient's emotional language is broadly consistent with the physiological readings, suggesting the self-report is generally believable and emotionally open."
            : "Across recent chats, there is a mixed pattern: some check-ins appear emotionally open, while others suggest the patient may be holding back or struggling to identify internal stress accurately.";

  const firstAnalysis = recentAnalyses[0] || null;
  const lastAnalysis = recentAnalyses[recentAnalyses.length - 1] || null;
  const distinctEmotions = [...new Set(recentAnalyses.map(entry => entry.emotion).filter(Boolean))];
  const allKeywords = [...new Set(recentAnalyses.flatMap(entry => entry.keywords || []))];
  const improvementLine =
    firstAnalysis && lastAnalysis && recentAnalyses.length > 1
      ? `Across the day, the conversation moved from ${firstAnalysis.emotion || firstAnalysis.sentiment} early on to ${lastAnalysis.emotion || lastAnalysis.sentiment} in the latest check-in${lastAnalysis.sentimentScore > firstAnalysis.sentimentScore ? ", suggesting some improvement after continued conversation and support." : lastAnalysis.sentimentScore < firstAnalysis.sentimentScore ? ", suggesting worsening emotional strain over the course of the day." : ", with no major overall emotional shift across the day."}`
      : "There is only limited same-day conversation data, so day-long emotional progression is still unclear.";
  const conversationBreadthLine =
    recentAnalyses.length
      ? `Today's AI-chat record includes ${recentAnalyses.length} meaningful check-ins, with recurring emotions/themes around ${distinctEmotions.join(", ") || "unclear emotional content"}${allKeywords.length ? ` and triggers involving ${allKeywords.join(", ")}` : ""}.`
      : "No same-day AI chat pattern is available yet.";
  const chatMomentLines = relevantChatMoments.length
    ? relevantChatMoments.map(moment => `- ${moment.time}: likely stress theme was ${moment.triggerSummary}. ${moment.responseStyle} ${moment.assistantSummary} Nearby vitals: ${moment.vitalsSummary}.`).join("\n")
    : "- No clinically relevant AI-chat moments have been recorded yet.";

  return [
    `Clinical Report: ${patient.name}`,
    ``,
    `1. Overview`,
    `${patient.name}, age ${patient.age}, is being followed for ${patient.condition}. Current assigned risk level is ${patient.risk}. Baseline self-report markers currently show mood ${displayValue(patient.mood, "/10")}, sleep ${displayValue(patient.sleep, " hours")}, and a ${patient.streak}-day check-in streak.`,
    ``,
    `2. Current Presentation`,
    topConcern,
    vitalsLine,
    interpretation,
    truthfulnessLine,
    improvementLine,
    causeLine,
    ``,
    `3. Recent Pattern Summary`,
    summary?.text || "No daily summary is available yet.",
    conversationBreadthLine,
    `Repeated themes/triggers: ${keywords}.`,
    relevantChatSection,
    ``,
    `4. Clinical Meaning`,
    latestAnalysis?.discrepancy === "hidden_stress"
      ? "There is a mismatch between outwardly steadier language and elevated physiological stress markers, which may suggest emotional suppression, under-reporting of distress, or limited insight into internal state."
      : latestAnalysis?.discrepancy === "emotional_without_physical"
        ? "The patient is describing meaningful distress without strong simultaneous physiological activation, which may reflect cognitive/emotional strain more than autonomic arousal at that moment."
        : latestAnalysis?.riskSignals?.crisis
          ? "Recent language indicates elevated safety concern and should be clinically reviewed without delay."
          : "Current verbal and physiological data are broadly aligned, suggesting the patient’s self-report is matching recent body-state indicators.",
    emotionMaskingLine,
    ``,
    `5. Suggested Follow-up`,
    latestAnalysis?.riskSignals?.crisis
      ? "Prioritize direct safety assessment, review supports, and confirm immediate supervision or crisis resources as clinically appropriate."
      : latestAnalysis?.stressLevel === "high"
        ? "Review recent stressors, assess coping capacity, and explore whether worsening mood, academic strain, body-image concerns, or eating patterns are contributing to the current presentation."
        : "Continue routine monitoring, reinforce helpful coping strategies, and track whether repeated trigger themes continue over the next several check-ins.",
    latestNote ? `Most recent clinician note on file: ${latestNote}` : "No clinician note has been added yet for this patient."
  ].join("\n");
}

function buildClinicalReportPrompt(patientId) {
  const patient = getPatientById(patientId);
  const insight = getPatientInsight(patientId);
  const latestAnalysis = insight?.latestAnalysis;
  const latestVitals = insight?.latestVitals;
  const summary = insight?.dailySummary;
  const todaysAnalyses = (db.analyses[patientId] || []).filter(entry => isSameDay(entry.timestamp)).slice().reverse();
  const relevantChatMoments = buildRelevantChatMoments(patientId);
  const conversationSummary = relevantChatMoments.length
    ? relevantChatMoments.map(moment => `- ${moment.time}: patient said "${moment.patientText}". Likely stress cause/theme: ${moment.triggerSummary}. Patient response style: ${moment.responseStyle} Assistant reply summary: ${moment.assistantSummary} Nearby vitals: ${moment.vitalsSummary}. Stress estimate: ${moment.stressLevel} (${moment.stressScore}/10).`).join("\n")
    : "No clinically relevant AI-chat moments recorded yet.";
  const recentNotes = (db.notesByPatient[patientId] || []).slice(0, 3).map(entry => `- ${entry.note}`).join("\n") || "No clinician notes on file.";
  const discrepancies = (insight?.discrepancies || []).slice(0, 3).map(entry => `- ${entry.title}: ${entry.desc}`).join("\n") || "No recent discrepancy events.";

  return `
You are generating a concise clinical report for a doctor reviewing a patient in a mental-health monitoring dashboard.

Write in clear professional language.
Do not mention AI, prompts, hidden context, sentiment labels, fusion scores, or model reasoning.
Do not invent facts that are not provided.
Keep it useful for a doctor: focused, readable, and action-oriented.
Avoid long paragraphs.
Explicitly compare what the patient said in chats with what the vitals suggest.
State whether the patient appears emotionally open, mixed, or possibly masking distress relative to the physiology.
Use the whole day's chat pattern when available, not only the latest message.
Prioritize only clinically relevant AI-chat moments: likely causes/triggers of stress, how the patient answered, and the vitals around those moments.
Do not waste space on greetings, filler, or non-clinical chat turns.

Output exactly these sections with short content:
Clinical Report
Overview
Current Presentation
Recent Pattern Summary
Relevant AI-Chat Discussion
Clinical Meaning
Suggested Follow-up

Patient:
- Name: ${patient.name}
- Age: ${patient.age}
- Condition: ${patient.condition}
- Assigned risk: ${patient.risk}
- Mood score: ${displayValue(patient.mood, "/10")}
- Sleep: ${displayValue(patient.sleep, " hours")}
- Check-in streak: ${patient.streak} days

Latest vitals:
${latestVitals ? `- HR: ${latestVitals.hr}\n- HRV: ${latestVitals.hrv}\n- EDA: ${latestVitals.eda}` : "- No recent vitals available"}

Latest check-in analysis:
${latestAnalysis ? `- Emotion: ${latestAnalysis.emotion}
- Stress level: ${latestAnalysis.stressLevel}
- Discrepancy: ${latestAnalysis.discrepancy.replaceAll("_", " ")}
- Insight: ${latestAnalysis.insight}
- Crisis language: ${latestAnalysis.riskSignals?.crisis ? "yes" : "no"}` : "- No recent analysis available"}

Daily summary:
${summary?.text || "No daily summary available."}

Relevant AI-Chat Discussion:
${conversationSummary}

Recent discrepancy events:
${discrepancies}

Recent clinician notes:
${recentNotes}
`.trim();
}

async function generateClinicalReportFromModel(patientId) {
  const prompt = buildClinicalReportPrompt(patientId);
  const requiredChatSection = buildRelevantChatSection(patientId);

  if (LLM_PROVIDER === "ollama" || LLM_PROVIDER === "auto") {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          messages: [
            {
              role: "system",
              content: "You write concise doctor-facing clinical summaries. Be factual, clear, and structured."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          options: {
            temperature: 0.4,
            num_predict: 500
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama report request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const text = data?.message?.content?.trim();
      if (text && !/you are generating|hidden context|prompt|system:/i.test(text)) {
        return /Relevant AI-Chat Discussion/i.test(text) ? text : `${text}\n\n${requiredChatSection}`;
      }
    } catch (error) {
      console.error(error);
      if (LLM_PROVIDER === "ollama") return null;
    }
  }

  if ((LLM_PROVIDER === "gemini" || LLM_PROVIDER === "auto") && GEMINI_API_KEY) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0.4,
            topP: 0.9,
            maxOutputTokens: 600
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini report request failed: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
      if (text) return /Relevant AI-Chat Discussion/i.test(text) ? text : `${text}\n\n${requiredChatSection}`;
    } catch (error) {
      console.error(error);
    }
  }

  return null;
}

function handleLogin(role, username, password) {
  if (role === "doctor" && username === db.doctorUser.username && password === db.doctorUser.password) {
    return {
      token: createToken({
        sub: db.doctorUser.id,
        role: "doctor",
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8
      }),
      role: "doctor",
      user: {
        id: db.doctorUser.id,
        name: db.doctorUser.name,
        username: db.doctorUser.username,
        role: db.doctorUser.role,
        specialty: db.doctorUser.specialty
      }
    };
  }

  if (role === "patient") {
    const patient = db.patients.find(entry => entry.username === username && entry.password === password);
    if (patient) {
      return {
        token: createToken({
          sub: patient.id,
          role: "patient",
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8
        }),
        role: "patient",
        user: getSafePatient(getDerivedPatientProfile(patient))
      };
    }
  }

  return null;
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    json(res, 404, { error: "Not found" });
    return;
  }

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  try {
    if (req.method === "POST" && pathname === "/api/login") {
      const { role, username, password } = await parseBody(req);
      const session = handleLogin(role, username, password);
      if (!session) {
        json(res, 401, { error: "Invalid credentials" });
        return;
      }
      json(res, 200, session);
      return;
    }

    if (req.method === "GET" && pathname === "/api/thingspeak/latest") {
      const session = requireSession(req, res);
      if (!session) return;
      const patientId = session.role === "doctor" ? searchParams.get("patient_id") || db.patients[0]?.id : session.sub;
      const vitals = await latestVitalsForPatient(patientId);
      if (!vitals) {
        json(res, 404, { error: "No real vitals available yet" });
        return;
      }
      json(res, 200, vitals);
      return;
    }

    if (req.method === "POST" && pathname === "/api/thingspeak/ingest") {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const { patient_id: patientId, hr, hrv, eda } = await parseBody(req);
      const patient = getPatientById(patientId);
      if (!patient) {
        json(res, 404, { error: "Patient not found" });
        return;
      }
      const entry = recordSensor(patientId, {
        hr: Number(hr),
        hrv: Number(hrv),
        eda: Number(eda),
        timestamp: isoNow(),
        source: "manual"
      });
      patient.hr = entry.hr;
      patient.hrv = entry.hrv;
      patient.eda = entry.eda;
      saveDb(db);
      json(res, 201, entry);
      return;
    }

    if (req.method === "PATCH" && pathname.startsWith("/api/thingspeak/mock-profile/")) {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      json(res, 410, { error: "Mock sensor profiles are disabled. Only real ingested or ThingSpeak data is supported." });
      return;
    }

    if (req.method === "GET" && pathname === "/api/patient/messages") {
      const session = requireSession(req, res, "patient");
      if (!session) return;
      json(res, 200, db.messagesByPatient[session.sub] || []);
      return;
    }

    if (req.method === "GET" && pathname === "/api/patient/checkin") {
      const session = requireSession(req, res, "patient");
      if (!session) return;
      const slot = getPromptSlot();
      const patientId = session.sub;
      const summary = buildDailySummary(patientId);
      json(res, 200, {
        promptSlot: slot,
        starter: getPromptText(slot),
        messages: getRecentChatMessages(patientId),
        profile: getSafePatient(getDerivedPatientProfile(getPatientById(patientId))),
        latestAnalysis: db.analyses[patientId]?.[0] || null,
        dailySummary: summary
      });
      saveDb(db);
      return;
    }

    if (req.method === "GET" && pathname === "/api/patient/summary") {
      const session = requireSession(req, res, "patient");
      if (!session) return;
      json(res, 200, getPatientInsight(session.sub));
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai/chat") {
      const session = requireSession(req, res, "patient");
      if (!session) return;

      const patient = getPatientById(session.sub);
      const body = await parseBody(req);
      const requestMessages = Array.isArray(body.messages) ? body.messages : [];
      const normalizedRequestHistory = requestMessages
        .filter(message => message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string")
        .map(message => ({
          role: message.role,
          text: message.text.trim()
        }))
        .filter(message => message.text);
      const lastUserMessage = [...normalizedRequestHistory].reverse().find(message => message.role === "user")?.text || "";
      const slot = getPromptSlot();
      if (shouldResetChatIntent(lastUserMessage)) {
        const starter = "Let’s start fresh. How are you feeling right now? You can also tell me a little about what has been on your mind lately.";
        db.chats[patient.id] = [
          {
            id: randomUUID(),
            role: "assistant",
            text: starter,
            time: isoNow()
          }
        ];
        db.analyses[patient.id] = [];
        db.summaries[patient.id] = {
          date: todayKey(),
          text: `${patient.name} started a fresh chat today.`,
          averageStress: null,
          negatives: 0,
          crisisCount: 0,
          keywords: [],
          latestVitals: db.sensorHistory[patient.id]?.[0] || null
        };
        saveDb(db);
        json(res, 200, {
          reset: true,
          text: starter,
          analysis: null,
          summary: db.summaries[patient.id]
        });
        return;
      }

      const vitals = await latestVitalsForPatient(patient.id);
      const analysis = analyzeText(lastUserMessage);
      const fusion = computeFusion(patient, vitals, analysis);
      const history = normalizedRequestHistory.length
        ? normalizedRequestHistory.slice(0, -1)
        : (db.chats[patient.id] || []).slice().reverse();
      let reply = null;
      if (analysis.riskSignals.crisis) {
        reply = "I’m really glad you said that. If you might act on this or feel unsafe right now, contact emergency help or a crisis line immediately and tell a trusted person near you right now. If you can, send this message to someone: I need you with me now.";
      } else {
        try {
          reply = await generateModelReply({
            patient,
            analysis,
            fusion,
            slot,
            vitals,
            history,
            userMessage: lastUserMessage
          });
        } catch (error) {
          console.error(error);
        }
      }

      if (!reply) {
        reply = buildBehavioralFallback({
          patient,
          analysis,
          fusion,
          slot,
          vitals,
          history,
          userMessage: lastUserMessage
        });
      }

      db.chats[patient.id] ||= [];
      db.chats[patient.id].unshift({
        id: randomUUID(),
        role: "assistant",
        text: reply,
        time: isoNow()
      });
      db.chats[patient.id].unshift({
        id: randomUUID(),
        role: "user",
        text: lastUserMessage,
        time: isoNow()
      });
      trimList(db.chats[patient.id], 80);

      const analysisEntry = {
        id: randomUUID(),
        timestamp: isoNow(),
        promptSlot: slot,
        text: lastUserMessage,
        ...analysis,
        stressScore: clamp(fusion.score, 0, 10),
        stressLevel: fusion.level,
        discrepancy: fusion.discrepancy,
        insight: fusion.insight
      };
      db.analyses[patient.id] ||= [];
      db.analyses[patient.id].unshift(analysisEntry);
      trimList(db.analyses[patient.id], 120);

      updatePatientFromAnalysis(patient, analysis, vitals);
      patient.streak = deriveCheckInStreak(patient.id);
      patient.mood = deriveMoodScore(patient.id) ?? patient.mood;
      if (analysis.riskSignals.crisis) {
        patient.risk = "high";
        db.messagesByPatient[patient.id] ||= [];
        db.messagesByPatient[patient.id].unshift({
          id: randomUUID(),
          doctor_name: "System Alert",
          content: "Urgent safety language was detected in the latest patient check-in. Please review immediately.",
          sent_at: isoNow()
        });
      }
      const summary = buildDailySummary(patient.id);
      saveDb(db);

      json(res, 200, {
        text: reply,
        analysis: analysisEntry,
        summary
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/doctor/patients") {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      json(res, 200, db.patients.map(getPatientOverview));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/doctor/patient-insights/")) {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const patientId = pathname.split("/").pop();
      const insight = getPatientInsight(patientId);
      if (!insight) {
        json(res, 404, { error: "Patient not found" });
        return;
      }
      json(res, 200, insight);
      return;
    }

    if (req.method === "POST" && pathname === "/api/doctor/patients") {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const body = await parseBody(req);
      const patient = {
        id: randomUUID(),
        name: body.name,
        username: body.name,
        password: body.password,
        age: Number(body.age),
        condition: body.condition,
        risk: body.risk || "medium",
        mood: null,
        sleep: null,
        streak: 0,
        hr: null,
        hrv: null,
        eda: null,
        avatar: createAvatar(body.name)
      };
      db.patients.push(patient);
      db.notesByPatient[patient.id] = [];
      db.messagesByPatient[patient.id] = [];
      db.chats[patient.id] = [];
      db.analyses[patient.id] = [];
      db.sensorHistory[patient.id] = [];
      buildDailySummary(patient.id);
      saveDb(db);
      json(res, 201, getSafePatient(patient));
      return;
    }

    if (req.method === "DELETE" && pathname.startsWith("/api/doctor/patients/")) {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const patientId = pathname.split("/").pop();
      const index = db.patients.findIndex(patient => patient.id === patientId);
      if (index === -1) {
        json(res, 404, { error: "Patient not found" });
        return;
      }
      db.patients.splice(index, 1);
      delete db.notesByPatient[patientId];
      delete db.messagesByPatient[patientId];
      delete db.chats[patientId];
      delete db.analyses[patientId];
      delete db.sensorHistory[patientId];
      delete db.summaries[patientId];
      saveDb(db);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "PATCH" && pathname.startsWith("/api/doctor/patients/")) {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const patientId = pathname.split("/").pop();
      const patient = getPatientById(patientId);
      if (!patient) {
        json(res, 404, { error: "Patient not found" });
        return;
      }
      const body = await parseBody(req);
      if (body.risk) patient.risk = body.risk;
      saveDb(db);
      json(res, 200, getSafePatient(patient));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/doctor/notes/")) {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const patientId = pathname.split("/").pop();
      json(res, 200, db.notesByPatient[patientId] || []);
      return;
    }

    if (req.method === "POST" && pathname === "/api/doctor/notes") {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const { patient_id: patientId, note } = await parseBody(req);
      const entry = {
        id: randomUUID(),
        note,
        created_at: isoNow()
      };
      db.notesByPatient[patientId] ||= [];
      db.notesByPatient[patientId].unshift(entry);
      saveDb(db);
      json(res, 201, entry);
      return;
    }

    if (req.method === "POST" && pathname === "/api/doctor/message") {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const { patient_id: patientId, content } = await parseBody(req);
      const entry = {
        id: randomUUID(),
        doctor_name: db.doctorUser.name,
        content,
        sent_at: isoNow()
      };
      db.messagesByPatient[patientId] ||= [];
      db.messagesByPatient[patientId].unshift(entry);
      saveDb(db);
      json(res, 201, entry);
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai/report") {
      const session = requireSession(req, res, "doctor");
      if (!session) return;
      const body = await parseBody(req);
      const patientId = body?.patient?.id;
      if (!patientId || !getPatientById(patientId)) {
        json(res, 404, { error: "Patient not found" });
        return;
      }
      const generated = await generateClinicalReportFromModel(patientId);
      json(res, 200, { report: generated || buildClinicalReport(patientId) });
      return;
    }

    if (tryServeFrontend(req, res, pathname)) {
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`NeuroMind backend listening on http://${HOST}:${PORT}`);
  if (fs.existsSync(INDEX_PATH)) {
    console.log("Frontend static build detected and will be served by the same Node server.");
  } else {
    console.log("No frontend build found yet. Run `npm run build` before deploying the full app.");
  }
  if (THINGSPEAK_CHANNEL_ID) {
    console.log(`ThingSpeak mode enabled for channel ${THINGSPEAK_CHANNEL_ID}`);
  } else {
    console.log("ThingSpeak mode not configured; no synthetic vitals fallback will be used.");
  }
});

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT || 4173);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "ballot-data.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const defaultData = {
  session: {
    committeeTitle: "인사자문위원회 비밀투표",
    ballotTitle: "",
    priorityCount: 3,
    isOpen: true,
    notice: "직위, 성함, 핸드폰번호 뒷자리 4개를 입력한 뒤 우선순위 교과를 작성하고 서명해 주세요."
  },
  voters: [
    { id: "voter-1", position: "교사", name: "홍길동", code: "1001", hasVoted: false, signature: null, signedAt: null }
  ],
  votes: [],
  audit: []
};

const adminTokens = new Set();

function getLocalUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
  }
}

function readData() {
  ensureData();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 6_000_000) {
        reject(new Error("요청 데이터가 너무 큽니다."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("JSON 형식이 올바르지 않습니다."));
      }
    });
  });
}

function cleanText(value, max = 80) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

function makeCode(existingCodes) {
  let code = "";
  do {
    code = String(crypto.randomInt(1000, 10000));
  } while (existingCodes.has(code));
  existingCodes.add(code);
  return code;
}

function getBearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function requireAdmin(req, res) {
  const token = getBearer(req);
  if (!adminTokens.has(token)) {
    send(res, 401, { error: "관리자 인증이 필요합니다." });
    return false;
  }
  return true;
}

function publicSession(data) {
  return {
    committeeTitle: data.session.committeeTitle,
    ballotTitle: data.session.ballotTitle,
    priorityCount: data.session.priorityCount,
    isOpen: data.session.isOpen,
    notice: data.session.notice
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");

  fs.readFile(filePath, (err, content) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const data = readData();

  try {
    if (req.method === "GET" && url.pathname === "/api/session") {
      return send(res, 200, { session: publicSession(data) });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/voter/verify") {
      const body = await parseJson(req);
      const position = cleanText(body.position);
      const name = cleanText(body.name);
      const code = cleanText(body.code, 20);
      const voter = data.voters.find(v =>
        v.position === position && v.name === name && safeEqual(v.code, code)
      );
      if (!data.session.isOpen) return send(res, 403, { error: "현재 투표가 열려 있지 않습니다." });
      if (!voter) return send(res, 404, { error: "등록된 직위/성함/핸드폰번호 뒷자리 4개와 일치하지 않습니다." });
      if (voter.hasVoted) return send(res, 409, { error: "이미 제출이 완료된 참여자입니다." });
      return send(res, 200, { voterId: voter.id, voter: { position: voter.position, name: voter.name } });
    }

    if (req.method === "POST" && url.pathname === "/api/vote") {
      const body = await parseJson(req);
      const voter = data.voters.find(v => v.id === cleanText(body.voterId, 80) && safeEqual(v.code, cleanText(body.code, 20)));
      if (!data.session.isOpen) return send(res, 403, { error: "현재 투표가 열려 있지 않습니다." });
      if (!voter) return send(res, 404, { error: "참여자 확인에 실패했습니다." });
      if (voter.hasVoted) return send(res, 409, { error: "이미 제출이 완료된 참여자입니다." });

      const priorities = Array.isArray(body.priorities)
        ? body.priorities.map(v => cleanText(v, 80)).filter(Boolean)
        : [];
      const requiredCount = Math.max(1, Number(data.session.priorityCount || 1));
      if (priorities.length < requiredCount) {
        return send(res, 400, { error: `${requiredCount}순위까지 모두 입력해 주세요.` });
      }
      if (new Set(priorities.map(v => v.toLowerCase())).size !== priorities.length) {
        return send(res, 400, { error: "같은 교과를 중복 입력할 수 없습니다." });
      }
      const signature = String(body.signature || "");
      if (!signature.startsWith("data:image/png;base64,") || signature.length < 500) {
        return send(res, 400, { error: "서명을 입력해 주세요." });
      }

      const receipt = makeId("receipt");
      data.votes.push({
        receipt,
        submittedAt: new Date().toISOString(),
        priorities
      });
      voter.hasVoted = true;
      voter.signature = signature;
      voter.signedAt = new Date().toISOString();
      data.audit.push({ at: new Date().toISOString(), type: "vote-submitted" });
      writeData(data);
      return send(res, 200, { receipt });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const body = await parseJson(req);
      if (!safeEqual(body.password, ADMIN_PASSWORD)) return send(res, 401, { error: "비밀번호가 올바르지 않습니다." });
      const token = crypto.randomBytes(24).toString("hex");
      adminTokens.add(token);
      return send(res, 200, { token });
    }

    if (url.pathname.startsWith("/api/admin/") && !requireAdmin(req, res)) return;

    if (req.method === "GET" && url.pathname === "/api/admin/state") {
      return send(res, 200, {
        session: data.session,
        voters: data.voters.map(v => ({
          id: v.id,
          position: v.position,
          name: v.name,
          code: v.code,
          hasVoted: v.hasVoted,
          signedAt: v.signedAt,
          signature: v.signature
        })),
        votes: data.votes
      });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/state") {
      const body = await parseJson(req);
      const existingCodes = new Set();
      data.session = {
        committeeTitle: cleanText(body.session?.committeeTitle, 120) || defaultData.session.committeeTitle,
        ballotTitle: cleanText(body.session?.ballotTitle, 160) || defaultData.session.ballotTitle,
        priorityCount: Math.min(10, Math.max(1, Number(body.session?.priorityCount || 3))),
        isOpen: Boolean(body.session?.isOpen),
        notice: cleanText(body.session?.notice, 240)
      };
      data.voters = (Array.isArray(body.voters) ? body.voters : []).map((v, index) => {
        const previous = data.voters.find(old => old.id === v.id);
        const code = cleanText(v.code, 20) || makeCode(existingCodes);
        existingCodes.add(code);
        return {
          id: cleanText(v.id, 80) || makeId(`voter-${index + 1}`),
          position: cleanText(v.position, 40),
          name: cleanText(v.name, 40),
          code,
          hasVoted: Boolean(previous?.hasVoted),
          signature: previous?.signature || null,
          signedAt: previous?.signedAt || null
        };
      }).filter(v => v.position && v.name);
      data.audit.push({ at: new Date().toISOString(), type: "admin-updated" });
      writeData(data);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/reset-votes") {
      data.votes = [];
      data.voters = data.voters.map(v => ({ ...v, hasVoted: false, signature: null, signedAt: null }));
      data.audit.push({ at: new Date().toISOString(), type: "votes-reset" });
      writeData(data);
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "API를 찾을 수 없습니다." });
  } catch (error) {
    return send(res, 400, { error: error.message || "요청 처리 중 오류가 발생했습니다." });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) return handleApi(req, res);
  return serveStatic(req, res);
});

ensureData();
server.listen(PORT, () => {
  console.log(`인사자문위원회 비밀투표 앱 실행 중: http://localhost:${PORT}`);
  for (const url of getLocalUrls(PORT)) {
    console.log(`핸드폰 접속 주소: ${url}`);
  }
  console.log("혜민 비밀번호는 설정된 운영 비밀번호를 사용하세요.");
});

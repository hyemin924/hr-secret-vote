const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

let session = null;
let verified = null;
let adminToken = localStorage.getItem("adminToken") || "";
let adminState = null;
let signatureDirty = false;

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (options.admin) headers.Authorization = `Bearer ${adminToken}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "요청 처리에 실패했습니다.");
  return data;
}

function setView(id) {
  $$(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === id));
  $$(".view").forEach(view => view.classList.toggle("active", view.id === id));
}

function renderSession() {
  $("#committeeTitle").textContent = session.committeeTitle;
  $("#ballotTitle").textContent = session.ballotTitle || "";
  $("#ballotTitle").classList.toggle("hidden", !session.ballotTitle);
  $("#notice").textContent = session.notice;
  const badge = $("#openBadge");
  badge.textContent = session.isOpen ? "투표 진행 중" : "투표 마감";
  badge.classList.toggle("closed", !session.isOpen);
}

function renderPriorityFields() {
  const wrap = $("#priorityFields");
  wrap.innerHTML = "";
  for (let i = 1; i <= session.priorityCount; i += 1) {
    const label = document.createElement("label");
    label.textContent = `${i}순위 교과`;
    const input = document.createElement("input");
    input.name = "priority";
    input.required = true;
    input.placeholder = i === 1 ? "예: 과학" : i === 2 ? "예: 미술" : `${i}순위 교과명`;
    label.appendChild(input);
    wrap.appendChild(label);
  }
}

function setupTabs() {
  $$(".tab").forEach(tab => tab.addEventListener("click", () => {
    setView(tab.dataset.view);
    if (tab.dataset.view === "adminView" && adminToken) loadAdmin();
  }));
}

function resizeCanvas() {
  const canvas = $("#signaturePad");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const old = canvas.toDataURL();
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#17202a";
  if (signatureDirty) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
    img.src = old;
  }
}

function setupSignature() {
  const canvas = $("#signaturePad");
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let last = null;

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    const touch = event.touches ? event.touches[0] : event;
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function start(event) {
    event.preventDefault();
    drawing = true;
    last = point(event);
  }

  function move(event) {
    if (!drawing) return;
    event.preventDefault();
    const next = point(event);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    last = next;
    signatureDirty = true;
  }

  function end() {
    drawing = false;
    last = null;
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", end);
  window.addEventListener("resize", resizeCanvas);
  $("#clearSignature").addEventListener("click", () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    signatureDirty = false;
  });
  resizeCanvas();
}

function setupVote() {
  $("#verifyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const data = await api("/api/voter/verify", {
        method: "POST",
        body: JSON.stringify({
          position: form.get("position"),
          name: form.get("name"),
          code: form.get("code")
        })
      });
      verified = { ...data, code: String(form.get("code") || "") };
      $("#confirmedVoter").textContent = `${data.voter.position} ${data.voter.name} 선생님으로 확인되었습니다.`;
      $("#verifyForm").classList.add("hidden");
      $("#voteForm").classList.remove("hidden");
      renderPriorityFields();
      setTimeout(resizeCanvas, 0);
    } catch (error) {
      toast(error.message);
    }
  });

  $("#backToVerify").addEventListener("click", () => {
    verified = null;
    $("#voteForm").classList.add("hidden");
    $("#verifyForm").classList.remove("hidden");
  });

  $("#voteForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!signatureDirty) return toast("서명을 입력해 주세요.");
    const priorities = $$("input[name='priority']").map(input => input.value.trim());
    try {
      const data = await api("/api/vote", {
        method: "POST",
        body: JSON.stringify({
          voterId: verified.voterId,
          code: verified.code,
          priorities,
          signature: $("#signaturePad").toDataURL("image/png")
        })
      });
      $("#receiptCode").textContent = data.receipt;
      $("#voteForm").classList.add("hidden");
      $("#donePanel").classList.remove("hidden");
      $("#verifyForm").reset();
    } catch (error) {
      toast(error.message);
    }
  });
}

function voterRow(voter = {}) {
  const row = document.createElement("div");
  row.className = "voter-row";
  row.dataset.id = voter.id || "";
  row.innerHTML = `
    <input class="v-position" placeholder="직위" value="${escapeHtml(voter.position || "")}">
    <input class="v-name" placeholder="성함" value="${escapeHtml(voter.name || "")}">
    <input class="v-code" placeholder="뒷자리 4개" inputmode="numeric" maxlength="4" value="${escapeHtml(voter.code || "")}">
    <button class="danger" type="button" aria-label="삭제">삭제</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  return row;
}

function normalizeColumnName(value) {
  return String(value || "").replace(/[\s()[\]{}_\-./]/g, "").toLowerCase();
}

function findColumn(headers, candidates) {
  const normalized = headers.map(normalizeColumnName);
  return normalized.findIndex(header => candidates.some(candidate => header.includes(candidate)));
}

function phoneLast4(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.slice(-4);
}

function compactVisibleRows() {
  $$("#voterRows .voter-row").forEach(row => {
    const values = [".v-position", ".v-name", ".v-code"].map(selector => row.querySelector(selector).value.trim());
    if (values.every(value => !value) && !row.dataset.id) row.remove();
  });
}

function rowsFromWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const table = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  const headerIndex = table.findIndex(row => row.some(cell => normalizeColumnName(cell)));
  if (headerIndex < 0) return [];

  const headers = table[headerIndex];
  let positionIndex = findColumn(headers, ["직위", "직책", "직급"]);
  let nameIndex = findColumn(headers, ["성함", "성명", "이름", "name"]);
  let phoneIndex = findColumn(headers, ["핸드폰번호뒷자리4개", "휴대폰번호뒷자리4개", "전화번호뒷자리4개", "핸드폰", "휴대폰", "전화번호", "뒷자리", "phone"]);

  if (positionIndex < 0 && nameIndex < 0) {
    positionIndex = 0;
    nameIndex = 1;
    phoneIndex = 2;
  }

  return table.slice(headerIndex + 1).map(row => ({
    position: String(row[positionIndex] || "").trim(),
    name: String(row[nameIndex] || "").trim(),
    code: phoneLast4(row[phoneIndex])
  })).filter(voter => voter.position || voter.name || voter.code);
}

async function importVotersFromFile(file) {
  if (!window.XLSX) throw new Error("엑셀 읽기 라이브러리를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
  const buffer = await file.arrayBuffer();
  const workbook = window.XLSX.read(buffer, { type: "array" });
  const voters = rowsFromWorkbook(workbook);
  if (!voters.length) throw new Error("엑셀에서 참여자 명단을 찾지 못했습니다.");

  compactVisibleRows();
  voters.forEach(voter => $("#voterRows").appendChild(voterRow(voter)));
  toast(`${voters.length}명을 엑셀에서 불러왔습니다. 저장 버튼을 눌러 반영해 주세요.`);
}

function downloadSampleWorkbook() {
  const rows = [
    ["직위", "성함", "핸드폰번호 뒷자리 4개"],
    ["교장", "홍길동", "1234"],
    ["교감", "김영희", "5678"]
  ];
  if (window.XLSX) {
    const workbook = window.XLSX.utils.book_new();
    const sheet = window.XLSX.utils.aoa_to_sheet(rows);
    window.XLSX.utils.book_append_sheet(workbook, sheet, "참여자명단");
    window.XLSX.writeFile(workbook, "participants-template.xlsx");
    return;
  }
  downloadCsv("participants-template.csv", rows);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function renderAdmin() {
  $("#loginForm").classList.add("hidden");
  $("#adminPanel").classList.remove("hidden");
  $("#isOpen").checked = adminState.session.isOpen;
  $("#adminCommitteeTitle").value = adminState.session.committeeTitle;
  $("#adminBallotTitle").value = adminState.session.ballotTitle;
  $("#priorityCount").value = adminState.session.priorityCount;
  $("#adminNotice").value = adminState.session.notice || "";
  const rows = $("#voterRows");
  rows.innerHTML = "";
  adminState.voters.forEach(voter => rows.appendChild(voterRow(voter)));
  $("#statVoters").textContent = adminState.voters.length;
  $("#statDone").textContent = adminState.voters.filter(v => v.hasVoted).length;
  $("#statVotes").textContent = adminState.votes.length;
  renderResults();
}

function renderResults() {
  const wrap = $("#voteResults");
  wrap.innerHTML = "";
  adminState.votes.slice().reverse().forEach((vote, index) => {
    const item = document.createElement("div");
    item.className = "result-item";
    item.textContent = `${adminState.votes.length - index}. ${vote.priorities.map((v, i) => `${i + 1}순위 ${v}`).join(" / ")} (${new Date(vote.submittedAt).toLocaleString("ko-KR")})`;
    wrap.appendChild(item);
  });
}

async function loadAdmin() {
  try {
    adminState = await api("/api/admin/state", { admin: true });
    renderAdmin();
  } catch {
    adminToken = "";
    localStorage.removeItem("adminToken");
    $("#loginForm").classList.remove("hidden");
    $("#adminPanel").classList.add("hidden");
  }
}

function collectAdminState() {
  return {
    session: {
      committeeTitle: $("#adminCommitteeTitle").value,
      ballotTitle: $("#adminBallotTitle").value,
      priorityCount: Number($("#priorityCount").value),
      isOpen: $("#isOpen").checked,
      notice: $("#adminNotice").value
    },
    voters: $$("#voterRows .voter-row").map(row => ({
      id: row.dataset.id,
      position: row.querySelector(".v-position").value,
      name: row.querySelector(".v-name").value,
      code: row.querySelector(".v-code").value
    }))
  };
}

function downloadCsv(filename, rows) {
  const csv = rows.map(row => row.map(cell => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function setupAdmin() {
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    try {
      const data = await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
      adminToken = data.token;
      localStorage.setItem("adminToken", adminToken);
      await loadAdmin();
    } catch (error) {
      toast(error.message);
    }
  });

  $("#addVoter").addEventListener("click", () => $("#voterRows").appendChild(voterRow()));

  $("#downloadSample").addEventListener("click", downloadSampleWorkbook);

  $("#uploadVoters").addEventListener("click", () => $("#voterFile").click());

  $("#voterFile").addEventListener("change", async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      await importVotersFromFile(file);
    } catch (error) {
      toast(error.message);
    }
  });

  $("#saveAdmin").addEventListener("click", async () => {
    try {
      await api("/api/admin/state", { method: "POST", admin: true, body: JSON.stringify(collectAdminState()) });
      toast("저장되었습니다.");
      await init();
      await loadAdmin();
    } catch (error) {
      toast(error.message);
    }
  });

  $("#downloadVoters").addEventListener("click", () => {
    const rows = [["직위", "성함", "핸드폰번호 뒷자리 4개", "제출여부", "서명시각"]];
    adminState.voters.forEach(v => rows.push([v.position, v.name, v.code, v.hasVoted ? "제출" : "미제출", v.signedAt || ""]));
    downloadCsv("participants.csv", rows);
  });

  $("#downloadVotes").addEventListener("click", () => {
    const rows = [["접수번호", "제출시각", ...Array.from({ length: adminState.session.priorityCount }, (_, i) => `${i + 1}순위`)]];
    adminState.votes.forEach(v => rows.push([v.receipt, v.submittedAt, ...v.priorities]));
    downloadCsv("secret-votes.csv", rows);
  });

  $("#downloadCombined").addEventListener("click", () => {
    const rows = [["직위", "성함", "핸드폰번호 뒷자리 4개", "접수번호", "제출시각", ...Array.from({ length: adminState.session.priorityCount }, (_, i) => `${i + 1}순위`)]];
    adminState.votes.forEach(v => rows.push([
      v.voter_position || "",
      v.voter_name || "",
      v.voter_phone_last4 || "",
      v.receipt,
      v.submittedAt,
      ...v.priorities
    ]));
    downloadCsv("combined-votes.csv", rows);
  });

  $("#resetVotes").addEventListener("click", async () => {
    if (!confirm("제출된 투표와 서명 기록을 초기화할까요?")) return;
    try {
      await api("/api/admin/reset-votes", { method: "POST", admin: true, body: "{}" });
      toast("초기화되었습니다.");
      await loadAdmin();
    } catch (error) {
      toast(error.message);
    }
  });
}

async function init() {
  const data = await api("/api/session");
  session = data.session;
  renderSession();
}

setupTabs();
setupSignature();
setupVote();
setupAdmin();
init().catch(error => toast(error.message));

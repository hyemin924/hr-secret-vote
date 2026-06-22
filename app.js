const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const cfg = window.SUPABASE_CONFIG || {};
const isConfigured = cfg.url && cfg.anonKey && !cfg.url.includes("YOUR_");
const db = isConfigured ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;

let session = null;
let verified = null;
let adminPassword = "";
let adminState = null;
let signatureDirty = false;

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}

function requireConfigured() {
  if (!db) {
    $("#setupWarning").classList.remove("hidden");
    throw new Error("Supabase 연결 설정이 필요합니다.");
  }
}

async function rpc(fn, args = {}) {
  requireConfigured();
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(error.message || "요청 처리에 실패했습니다.");
  if (data && data.error) throw new Error(data.error);
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
    input.placeholder = i === 1 ? "예: 과학" : `${i}순위 교과명`;
    label.appendChild(input);
    wrap.appendChild(label);
  }
}

function setupTabs() {
  $$(".tab").forEach(tab => tab.addEventListener("click", () => {
    setView(tab.dataset.view);
    if (tab.dataset.view === "adminView" && adminPassword) loadAdmin();
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
      const data = await rpc("verify_voter", {
        p_position: form.get("position"),
        p_name: form.get("name"),
        p_phone_last4: form.get("code")
      });
      verified = { ...data, phoneLast4: String(form.get("code") || "") };
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
      const data = await rpc("submit_vote", {
        p_voter_id: verified.voterId,
        p_phone_last4: verified.phoneLast4,
        p_priorities: priorities,
        p_signature: $("#signaturePad").toDataURL("image/png")
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function voterRow(voter = {}) {
  const row = document.createElement("div");
  row.className = "voter-row";
  row.dataset.id = voter.id || "";
  row.innerHTML = `
    <input class="v-position" placeholder="직위" value="${escapeHtml(voter.position || "")}">
    <input class="v-name" placeholder="성함" value="${escapeHtml(voter.name || "")}">
    <input class="v-code" placeholder="뒷자리 4개" inputmode="numeric" maxlength="4" value="${escapeHtml(voter.phone_last4 || voter.code || "")}">
    <button class="danger" type="button" aria-label="삭제">삭제</button>
  `;
  row.querySelector("button").addEventListener("click", () => row.remove());
  return row;
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
  $("#statDone").textContent = adminState.voters.filter(v => v.has_voted).length;
  $("#statVotes").textContent = adminState.votes.length;
  renderResults();
}

function renderResults() {
  const wrap = $("#voteResults");
  wrap.innerHTML = "";
  adminState.votes.slice().reverse().forEach((vote, index) => {
    const item = document.createElement("div");
    item.className = "result-item";
    item.textContent = `${adminState.votes.length - index}. ${vote.priorities.map((v, i) => `${i + 1}순위 ${v}`).join(" / ")} (${new Date(vote.submitted_at).toLocaleString("ko-KR")})`;
    wrap.appendChild(item);
  });
}

async function loadAdmin() {
  try {
    adminState = await rpc("admin_state", { p_password: adminPassword });
    renderAdmin();
  } catch (error) {
    adminPassword = "";
    $("#loginForm").classList.remove("hidden");
    $("#adminPanel").classList.add("hidden");
    toast(error.message);
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
      id: row.dataset.id || null,
      position: row.querySelector(".v-position").value,
      name: row.querySelector(".v-name").value,
      phone_last4: row.querySelector(".v-code").value
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
    adminPassword = String(new FormData(event.currentTarget).get("password") || "");
    await loadAdmin();
  });

  $("#addVoter").addEventListener("click", () => $("#voterRows").appendChild(voterRow()));

  $("#saveAdmin").addEventListener("click", async () => {
    try {
      await rpc("admin_save_state", {
        p_password: adminPassword,
        p_state: collectAdminState()
      });
      toast("저장되었습니다.");
      await init();
      await loadAdmin();
    } catch (error) {
      toast(error.message);
    }
  });

  $("#downloadVoters").addEventListener("click", () => {
    const rows = [["직위", "성함", "핸드폰번호 뒷자리 4개", "제출여부", "서명시각"]];
    adminState.voters.forEach(v => rows.push([v.position, v.name, v.phone_last4, v.has_voted ? "제출" : "미제출", v.signed_at || ""]));
    downloadCsv("participants.csv", rows);
  });

  $("#downloadVotes").addEventListener("click", () => {
    const rows = [["접수번호", "제출시각", ...Array.from({ length: adminState.session.priorityCount }, (_, i) => `${i + 1}순위`)]];
    adminState.votes.forEach(v => rows.push([v.receipt, v.submitted_at, ...v.priorities]));
    downloadCsv("secret-votes.csv", rows);
  });

  $("#resetVotes").addEventListener("click", async () => {
    if (!confirm("제출된 투표와 서명 기록을 초기화할까요?")) return;
    try {
      await rpc("admin_reset_votes", { p_password: adminPassword });
      toast("초기화되었습니다.");
      await loadAdmin();
    } catch (error) {
      toast(error.message);
    }
  });
}

async function init() {
  if (!isConfigured) {
    $("#setupWarning").classList.remove("hidden");
    return;
  }
  session = await rpc("get_public_session");
  renderSession();
}

setupTabs();
setupSignature();
setupVote();
setupAdmin();
init().catch(error => toast(error.message));

// filepath: /mnt/data/app.js

// ---------- Storage helpers ----------
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ---------- Firebase (optional) ----------
let FB = { app:null, auth:null, db:null, user:null };
function firebaseAvailable(){
  return typeof window !== 'undefined'
    && window.firebase && window.FIREBASE_CONFIG
    && window.FIREBASE_CONFIG.apiKey
    && !String(window.FIREBASE_CONFIG.apiKey).includes("PASTE_");
}
function initFirebaseAuth(){
  // (sync UI wired)
  try{
    if(!firebaseAvailable()) return;
    if (!FB.app) FB.app = firebase.initializeApp(window.FIREBASE_CONFIG);
    if (!FB.auth) FB.auth = firebase.auth();
    if (!FB.db) FB.db = firebase.firestore();
    FB.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    FB.auth.onAuthStateChanged(async (u)=>{
      FB.user = u || null;
      updateAuthUI();
      updateSyncControlsUI();
      if (FB.user) { try{ await loadRemoteState(); }catch{} }
    });
    const gbtn = document.getElementById("googleSignInBtn");
    const sbtn = document.getElementById("signOutBtn");
    if (gbtn) gbtn.addEventListener("click", async ()=>{
      try{
        const provider = new firebase.auth.GoogleAuthProvider();
        await FB.auth.signInWithPopup(provider);
      }catch(err){ alert("Giriş alınmadı: " + err.message); }
    });
    if (sbtn) sbtn.addEventListener("click", ()=> FB.auth.signOut());
  }catch{}
}
function updateAuthUI(){
  // (extended to handle sync controls)
  const gbtn = document.getElementById("googleSignInBtn");
  const badge = document.getElementById("userBadge");
  const nameEl = document.getElementById("userName");
  const photoEl = document.getElementById("userPhoto");
  if (!gbtn || !badge) return;
  if (FB.user){
    updateSyncControlsUI();
    gbtn.classList.add("hidden");
    badge.classList.remove("hidden");
    if (nameEl) nameEl.textContent = FB.user.displayName || FB.user.email || "İstifadəçi";
    if (photoEl){
      if (FB.user.photoURL){ photoEl.src = FB.user.photoURL; photoEl.classList.remove("hidden"); }
      else photoEl.classList.add("hidden");
    }
  } else {
    updateSyncControlsUI();
    gbtn.classList.remove("hidden");
    badge.classList.add("hidden");
  }
}
function collectLocalState(){
  const data = {};
  for (let i=0;i<localStorage.length;i++){
    const k = localStorage.key(i); if (!k) continue;
    if (k.startsWith("quiz_")) {
      try{ data[k] = JSON.parse(localStorage.getItem(k)); }
      catch{ data[k] = localStorage.getItem(k); }
    }
  }
  return data;
}
async function saveRemoteState(){
  if (!FB.user || !FB.db) return;
  const data = collectLocalState();
  const ref = FB.db.collection("users").doc(FB.user.uid).collection("appState").doc("state");
  await ref.set({ data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
}



// ---------- Cloud Sync: Robust Merge Helpers (added) ----------
const SYNC_META_KEY = 'quiz_sync_meta';

function _ensureObj(v){ return v && typeof v==='object' && !Array.isArray(v) ? v : {}; }
function _ensureArr(v){ return Array.isArray(v) ? v.slice() : []; }
function _uniqueNums(arr){ const s=new Set(_ensureArr(arr).map(x=>Number(x))); return Array.from(s).filter(n=>Number.isFinite(n)); }
function _uniqueStrings(arr){ const s=new Set(_ensureArr(arr).map(x=>String(x))); return Array.from(s); }
function _parseJSONMaybe(v){ try{ return JSON.parse(v); }catch{ return v; } }

function _mergeSelectedAnswers(localMap, remoteMap){
  const out = {};
  const L = _ensureObj(localMap), R = _ensureObj(remoteMap);
  const keys = _uniqueStrings([...Object.keys(L), ...Object.keys(R)]);
  keys.forEach(k=>{
    const a = L[k]; const b = R[k];
    if (a && !b){ out[k]=a; return; }
    if (!a && b){ out[k]=b; return; }
    const at = Number(a.updatedAt||0), bt = Number(b.updatedAt||0);
    out[k] = (bt>at) ? b : a;
  });
  return out;
}
function _mergeWrongCounts(la, ra){
  const L = _ensureObj(la), R = _ensureObj(ra), out = {};
  const keys = _uniqueStrings([...Object.keys(L), ...Object.keys(R)]);
  keys.forEach(k=> out[k] = Math.max(Number(L[k]||0), Number(R[k]||0)));
  return out;
}
function _mergeNotes(la, ra){
  const L = _ensureObj(la), R = _ensureObj(ra), out = {};
  const keys = _uniqueStrings([...Object.keys(L), ...Object.keys(R)]);
  keys.forEach(k=>{
    const l = String(L[k]||"").trim();
    const r = String(R[k]||"").trim();
    if (!l) out[k]=r;
    else if (!r) out[k]=l;
    else if (l===r) out[k]=l;
    else {
      // combine distinct notes; avoid duplication
      out[k] = (l.includes(r) ? l : (r.includes(l) ? r : (l + "\n" + r))).slice(0, 5000);
    }
  });
  return out;
}
function _mergeEdited(la, ra){
  const L = _ensureObj(la), R = _ensureObj(ra), out = {};
  const ids = _uniqueStrings([...Object.keys(L), ...Object.keys(R)]);
  ids.forEach(id=>{
    if (L[id] && !R[id]) out[id] = L[id];
    else if (!L[id] && R[id]) out[id] = R[id];
    else {
      // Prefer remote when both exist; keep local as before if remote misses it.
      const r = R[id], l = L[id];
      out[id] = r || l;
    }
  });
  return out;
}

function mergeKeyValue(key, localVal, remoteVal){
  const name = String(key);
  const L = localVal, R = remoteVal;
  if (/_selectedAnswers$/.test(name)) return _mergeSelectedAnswers(L, R);
  if (/_wrongQuestions$/.test(name))  return _uniqueNums([...(L||[]), ...(R||[])]);
  if (/_flaggedQuestions$/.test(name))return _uniqueNums([...(L||[]), ...(R||[])]);
  if (/_questionWrongCount$/.test(name)) return _mergeWrongCounts(L, R);
  if (/_questionNotes$/.test(name)) return _mergeNotes(L, R);
  if (/_editedQuestions$/.test(name)) return _mergeEdited(L, R);
  // default: prefer richer value (object > array > primitive length), fallback to remote
  try{
    const lStr = JSON.stringify(L)||"", rStr = JSON.stringify(R)||"";
    if (lStr.length >= rStr.length) return L ?? R;
    return R ?? L;
  }catch{ return R ?? L; }
}

function collectRemoteStateSnapshot(remoteData){
  const out = {};
  Object.keys(remoteData||{}).forEach(k=>{
    out[k] = remoteData[k];
  });
  return out;
}

function getCloudDocRef(){
  if (!FB.user || !FB.db) return null;
  return FB.db.collection("users").doc(FB.user.uid).collection("appState").doc("state");
}

async function fetchRemoteStateRaw(){
  const ref = getCloudDocRef(); if (!ref) return null;
  const snap = await ref.get();
  if (!snap.exists) return { data:{}, updatedAt: null };
  return snap.data() || { data:{} };
}

function saveSyncMeta(meta){
  try{
    const cur = loadJSON(SYNC_META_KEY, {}) || {};
    const next = Object.assign({}, cur, meta||{});
    saveJSON(SYNC_META_KEY, next);
    updateSyncStatusUI(); // try refresh
  }catch{}
}
function prettyTime(ts){
  if (!ts) return "—";
  try{
    const d = new Date(ts);
    const pad = n=>String(n).padStart(2,'0');
    return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+" "+pad(d.getHours())+":"+pad(d.getMinutes());
  }catch{ return "—"; }
}
function updateSyncStatusUI(){
  const el = document.getElementById("syncStatus");
  const meta = loadJSON(SYNC_META_KEY, {}) || {};
  if (!el) return;
  const up  = meta.upAt ? prettyTime(meta.upAt) : "—";
  const down= meta.downAt ? prettyTime(meta.downAt) : "—";
  // WHY: path gizlədilir, yalnız vaxtlar göstərilir
  el.textContent = `Bulud · ↑ ${up} · ↓ ${down}`;
}

async function mergeRemoteIntoLocalAndPush(remoteData){
  const localData = collectLocalState(); // current localStorage snapshot
  const merged = {};
  const keys = _uniqueStrings([...Object.keys(localData), ...Object.keys(remoteData||{})]);
  keys.forEach(k=>{
    const l = localData[k];
    const r = (remoteData||{})[k];
    // parse if strings
    const L = (typeof l==='string' ? _parseJSONMaybe(l) : l);
    const R = (typeof r==='string' ? _parseJSONMaybe(r) : r);
    merged[k] = mergeKeyValue(k, L, R);
  });

  // write merged back to localStorage
  Object.keys(merged).forEach(k=> saveJSON(k, merged[k]));

  // push merged back to cloud
  await saveRemoteState();
  return merged;
}

async function syncPullDown(){
  try{
    const remote = await fetchRemoteStateRaw();
    await mergeRemoteIntoLocalAndPush(remote && remote.data || {});
    saveSyncMeta({ downAt: Date.now() });
    loadCategoryState();
    renderAll();
    updateSyncStatusUI();
    setSyncControlsEnabled(true);
  }catch(e){
    alert("Buluddan çəkmək alınmadı: " + (e && e.message || e));
  }
}

async function syncPushUp(){
  try{
    // For safety, fetch first, merge, then push
    const remote = await fetchRemoteStateRaw();
    await mergeRemoteIntoLocalAndPush(remote && remote.data || {});
    saveSyncMeta({ upAt: Date.now() });
    updateSyncStatusUI();
    setSyncControlsEnabled(true);
  }catch(e){
    alert("Buluda yükləmək alınmadı: " + (e && e.message || e));
  }
}

function setSyncControlsEnabled(on){
  const up = document.getElementById("syncUpBtn");
  const down = document.getElementById("pullDownBtn");
  if (up) up.disabled = !on;
  if (down) down.disabled = !on;
}

function initSyncControlsUI(){
  const up = document.getElementById("syncUpBtn");
  const down = document.getElementById("pullDownBtn");
  const auto = document.getElementById("autoSyncToggle");

  if (up && !up.__wired){ up.__wired=true; up.addEventListener("click", ()=>{ setSyncControlsEnabled(false); syncPushUp(); }); }
  if (down && !down.__wired){ down.__wired=true; down.addEventListener("click", ()=>{ setSyncControlsEnabled(false); syncPullDown(); }); }

  if (auto && !auto.__wired){
    auto.__wired = true;
    const saved = localStorage.getItem('quiz_autoSync') === '1';
    auto.checked = saved;
    autoSyncEnabled = !!saved;
    auto.addEventListener("change", ()=>{
      autoSyncEnabled = !!auto.checked;
      localStorage.setItem('quiz_autoSync', autoSyncEnabled ? '1':'0');
    });
  }
  updateSyncStatusUI();
}

function updateSyncControlsUI(){
  initSyncControlsUI();
  const up = document.getElementById("syncUpBtn");
  const down = document.getElementById("pullDownBtn");
  const auto = document.getElementById("autoSyncToggle");
  const hasUser = !!FB.user;
  if (up) up.disabled = !hasUser;
  if (down) down.disabled = !hasUser;
  if (auto) auto.disabled = !hasUser;
}


function debounce(fn, wait){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; }
const saveRemoteStateDebounced = debounce(saveRemoteState, 1200);

async function loadRemoteState(){
  if (!FB.user || !FB.db) return;
  const remote = await fetchRemoteStateRaw();
  const data = (remote && remote.data) || {};
  await mergeRemoteIntoLocalAndPush(data);
  // After merge, hydrate and render
  loadCategoryState();
  renderAll();
  updateSyncStatusUI();
}


// ---------- Utils ----------
function hashString(s){ let h=5381; for (let i=0;i<s.length;i++){ h=((h<<5)+h)+s.charCodeAt(i); h|=0; } return h>>>0; }
function mulberry32(a){ return function(){ a|=0; a=(a+0x6D2B79F5)|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function stableShuffle(arr, seed){
  const a=arr.slice(); const rnd=mulberry32(seed);
  for (let i=a.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function shuffleArray(arr){ const a=arr.slice(); for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function truncate(t,m){ if(!t) return ""; return t.length>m?t.slice(0,m)+"…":t; }
function formatTime(x){ const m=Math.floor(x/60), s=x%60; return String(m).padStart(2,"0")+":"+String(s).padStart(2,"0"); }

// ---------- Session shuffle salt (changes every reload) ----------
const SESSION_SALT = ((Math.random()*4294967296)>>>0) ^ (Date.now()>>>0);
// Per-view shuffle salt (changes on category switch)
let VIEW_SALT = 0;


// ---------- Progress persistence helpers ----------
function persistProgress(){
  try {
    if (singleQuestionMode){
      saveJSON(storageKey("flash_currentPage"), currentPage);
    } else if (filterMode === "all"){
      saveJSON(storageKey("all_currentPage"), currentPage);
    }
  } catch {}
}
function restoreAllViewPage(){
  const p = loadJSON(storageKey("all_currentPage"), 1);
  if (typeof p === "number" && isFinite(p) && p>=1) currentPage = p;
}
function restoreFlashPage(){
  const p = loadJSON(storageKey("flash_currentPage"), 1);
  if (typeof p === "number" && isFinite(p) && p>=1) currentPage = p;
}
// ---------- State ----------
window.__suppressPageReset = false;
let allQuestions = [];
let currentCategory = null;
let currentPage = 1;
let questionsPerPage = 10;
let baseQuestionsPerPage = 10;
let singleQuestionMode = false;
let searchQuery = "";
let filterMode = "all"; restoreAllViewPage(); // all | wrong | flagged | noted

// Mask: wrong/flagged filtrinə girəndə bir dəfə cavabları gizlət, ilk klikdə aç
let maskMode = { active:false, cleared:false };

let selectedAnswers = {};
let wrongQuestions = [];
let flaggedQuestions = [];
let questionWrongCount = {};
let editedQuestions = {};
let questionNotes = {};

let isAdmin = false;
let autoSyncEnabled = localStorage.getItem('quiz_autoSync') === '1';

let flashOrderMode = "sequential"; // "sequential" | "random"
let orderedIds = [];
let randomOrderIds = [];

let exam = { running:false, durationSec:1800, endTime:null, timerId:null, lastResult:null, questionIds:[] };
// active card for keyboard navigation
let activeQuestionId = null;

// ALL mix: list of {file, weight}
let allMixConfig = loadJSON('quiz_all_mix', []);


// ---------- Helpers ----------
function storageKey(name){ return currentCategory ? ("quiz_"+currentCategory+"_"+name) : ("quiz_global_"+name); }

function normalizeQuestion(raw, index){
  const originalAnswers = Array.isArray(raw.answers) ? raw.answers.slice() : [];
  const correctAnswer = originalAnswers[0] || "";
  // Make answer order change on each page load while staying consistent within a single session
  const seedBase = hashString((raw.question||"")+"|"+originalAnswers.join("||"));
  const seed = (seedBase ^ SESSION_SALT ^ VIEW_SALT) >>> 0;
  const shuffled = stableShuffle(originalAnswers, seed);
  let correctIndex = Math.max(0, shuffled.indexOf(correctAnswer));
  return { id:index, question: raw.question||"", answers: shuffled, correctIndex };
}
function applyEditedQuestions(){
  Object.values(editedQuestions||{}).forEach((e)=>{
    const q = allQuestions.find(qq=>qq.id===e.id); if(!q) return;
    const src = e.active==="before" ? e.before : e.after;
    q.question = src.question; q.answers = src.answers.slice(); q.correctIndex = src.correctIndex;
  });
}

function loadCategoryState(){
  selectedAnswers     = loadJSON(storageKey("selectedAnswers"), {});
  wrongQuestions      = loadJSON(storageKey("wrongQuestions"), []);
  flaggedQuestions    = loadJSON(storageKey("flaggedQuestions"), []);
  questionWrongCount  = loadJSON(storageKey("questionWrongCount"), {});
  editedQuestions     = loadJSON(storageKey("editedQuestions"), {});
  questionNotes       = loadJSON(storageKey("questionNotes"), {});
}
function saveCategoryState(){
  saveJSON(storageKey("selectedAnswers"), selectedAnswers);
  saveJSON(storageKey("wrongQuestions"), wrongQuestions);
  saveJSON(storageKey("flaggedQuestions"), flaggedQuestions);
  saveJSON(storageKey("questionWrongCount"), questionWrongCount);
  saveJSON(storageKey("editedQuestions"), editedQuestions);
  saveJSON(storageKey("questionNotes"), questionNotes);
  try{ if (autoSyncEnabled && FB.user) saveRemoteStateDebounced(); }catch{}
}

// ---------- Stats ----------
function _resolveSelectedIndex(q, info){
  if (!info) return -1;
  if (typeof info.value === "string"){
    const idx = q.answers.indexOf(info.value);
    return idx>=0 ? idx : (typeof info.index==="number" ? info.index : -1);
  }
  return (typeof info.index==="number") ? info.index : -1;
}
function computeStats(){
  const total = allQuestions.length;
  const answered = Object.keys(selectedAnswers).length;
  let correct=0, wrong=0;
  for (const [idStr, info] of Object.entries(selectedAnswers)){
    const id = Number(idStr); const q = allQuestions.find(qq=>qq.id===id); if(!q) continue;
    const idx = _resolveSelectedIndex(q, info); if (idx===-1) continue;
    if (idx===q.correctIndex) correct++; else wrong++;
  }
  return { total, answered, correct, wrong, flagged: flaggedQuestions.length };
}

// ---------- Filtering / ordering ----------
function getFilteredQuestionsRaw(){
  let list = allQuestions.slice();
  const query = (searchQuery||"").trim().toLowerCase();

  if (query){
    list = list.filter((q)=>{
      if ((q.question||"").toLowerCase().includes(query)) return true;
      return (q.answers||[]).some(a=>a.toLowerCase().includes(query));
    });
  }

  if (filterMode === "wrong")   list = list.filter(q=>wrongQuestions.includes(q.id));
  if (filterMode === "flagged") list = list.filter(q=>flaggedQuestions.includes(q.id));
  if (filterMode === "noted")   list = list.filter(q=>!!questionNotes[q.id]);

  // Normal rejim random sıralama
  if (!singleQuestionMode){
    const orderRadio = document.querySelector('input[name="quizOrder"]:checked');
    if (orderRadio && orderRadio.value === "random"){
      const ids = list.map(q=>q.id);
      const same = (randomOrderIds.length===ids.length) && ids.every(id=>randomOrderIds.includes(id));
      if (!same) randomOrderIds = shuffleArray(ids);
      list = randomOrderIds.map(id => list.find(q=>q.id===id)).filter(Boolean);
    } else {
    updateSyncControlsUI();
      randomOrderIds = [];
    }
  }
  return list;
}
function recomputeOrderedIds(){
  const ids = getFilteredQuestionsRaw().map(q=>q.id);
  if (!singleQuestionMode){ orderedIds = ids; return; }
  orderedIds = (flashOrderMode === "random") ? shuffleArray(ids) : ids;
  currentPage = 1;
}
function getFilteredQuestions(){
  const raw = getFilteredQuestionsRaw();
  if (!singleQuestionMode) return raw;
  const set = new Set(orderedIds);
  return raw.filter(q=>set.has(q.id))
            .sort((a,b)=>orderedIds.indexOf(a.id)-orderedIds.indexOf(b.id));
}

// ---------- Keyboard helpers ----------

// Choose option by number key (1-9) within active question card
function chooseOptionByIndex(qid, n){
  const card = document.getElementById("question-"+qid);
  if (!card) return;
  const options = Array.from(card.querySelectorAll(".answers .answer-btn"));
  if (!options.length) return;
  const btn = options[n];
  if (btn) btn.click(); // WHY: triggers existing onAnswerClick
}

function getFilteredIds(){
  return getFilteredQuestions().map(q=>q.id);
}
function setActiveQuestion(id, opts){
  opts = opts || {};
  activeQuestionId = id;
  document.querySelectorAll(".question.active").forEach(el=>el.classList.remove("active"));
  const el = document.getElementById("question-"+id);
  if (el){
    el.classList.add("active");
    if (opts.scroll !== false){
      el.scrollIntoView({behavior:"smooth", block:"start"});
    }
  }
}
function moveActive(delta){
  const ids = getFilteredIds();
  if (!ids.length) return;
  let idx = activeQuestionId ? ids.indexOf(activeQuestionId) : -1;
  if (idx < 0) idx = 0;
  let nextIdx = idx + delta;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= ids.length) nextIdx = ids.length - 1;

  const per = questionsPerPage || baseQuestionsPerPage;
  const targetPage = Math.floor(nextIdx / per) + 1;
  const nextId = ids[nextIdx];
  if (currentPage !== targetPage){
    currentPage = targetPage;
    renderAll();
    requestAnimationFrame(()=> setActiveQuestion(nextId));
  } else {
    updateSyncControlsUI();
    setActiveQuestion(nextId);
  }
  persistProgress();
}

// ---------- ALL (Mixed Categories) ----------
function getAllCategoryFiles(){
  // Read available files from sidebar buttons
  const btns = document.querySelectorAll('.category-list .category-btn[data-category]');
  const files = [];
  btns.forEach(b=>{
    const f = b.getAttribute('data-category');
    if (f && f !== '__ALL__') files.push({file:f, label:b.textContent.trim()});
  });
  return files;
}
function showAllMixEditor(){
  const list = document.querySelector('.category-list');
  if (!list) return;
  // Remove old editors
  list.querySelectorAll('.mix-input').forEach(i=>i.remove());
  const saveOld = document.getElementById('mixSaveBtn');
  if (saveOld) saveOld.remove();

  // Add numeric inputs next to each category button
  const files = getAllCategoryFiles();
  const cfg = new Map((allMixConfig||[]).map(x=>[x.file, x.weight]));
  files.forEach(({file})=>{
    const btn = list.querySelector(`.category-btn[data-category="${file}"]`);
    if (!btn) return;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = '1';
    inp.placeholder = '0'; inp.value = cfg.has(file) ? String(cfg.get(file)) : '';
    inp.className = 'mix-input';
    inp.style.marginLeft='8px'; inp.style.width='64px'; inp.style.padding='4px 6px';
    inp.title = 'Bu kateqoriyadan neçə sual? (0-100)';
    btn.insertAdjacentElement('afterend', inp);
  });

  // Add Save button
  const saveBtn = document.createElement('button');
  saveBtn.id = 'mixSaveBtn';
  saveBtn.className = 'secondary-btn';
  saveBtn.style.marginTop = '8px';
  saveBtn.innerHTML = '<i class="fa fa-save"></i> ALL seçimini yadda saxla';
  list.parentElement.appendChild(saveBtn);

  saveBtn.addEventListener('click', ()=>{
    const inputs = Array.from(list.querySelectorAll('.mix-input'));
    const entries = inputs.map(inp=>{
      const btn = inp.previousElementSibling;
      const file = btn && btn.getAttribute('data-category');
      const w = parseInt(inp.value||'0',10);
      return {file, weight: isNaN(w)?0:w};
    }).filter(e=>e && e.file && e.weight>0);
    const total = entries.reduce((s,e)=>s+e.weight,0);
    if (total !== 100){
      alert('Toplam 100 olmalıdır. Hazırda: '+total);
      return;
    }
    allMixConfig = entries;
    saveJSON('quiz_all_mix', allMixConfig);
    // Clean inputs (for aesthetic)
    inputs.forEach(i=>i.remove());
    if (saveBtn) saveBtn.remove();
    selectAllMixedCategory();
  });
}
async function selectAllMixedCategory(){
  const list = getAllCategoryFiles();
  if (!allMixConfig || !allMixConfig.length){
    showAllMixEditor();
    return;
  }
  // UI selection
  document.querySelectorAll('.category-btn').forEach(b=>b.classList.remove('selected'));
  const allBtn = document.querySelector('.category-btn[data-category="__ALL__"]');
  if (allBtn) allBtn.classList.add('selected');

  currentCategory = 'ALL';
  currentPage = 1;
  filterMode = 'all'; restoreAllViewPage();
  maskMode = { active:false, cleared:false };
  exam.running=false; exam.lastResult=null; exam.questionIds=[];
  if (exam.timerId){ clearInterval(exam.timerId); exam.timerId=null; }

  const filesToLoad = allMixConfig.slice();
  // fetch all jsons
  const results = await Promise.all(filesToLoad.map(e=>fetch(e.file).then(r=>{
    if (!r.ok) throw new Error('Fayl tapılmadı: '+e.file);
    return r.json();
  }).then(data=>({file:e.file, weight:e.weight, data}))));

  // Build pool per file
  let rawMerged = [];
  for (const {file, weight, data} of results){
    const needed = Math.max(0, Math.min(100, weight));
    const arr = Array.isArray(data)? data.slice():[];
    // random sample needed from arr
    const shuffled = shuffleArray(arr);
    const take = shuffled.slice(0, needed);
    rawMerged = rawMerged.concat(take);
  }

  // Re-normalize with fresh ids 1..N
  allQuestions = rawMerged.map((q, idx)=> normalizeQuestion(q, idx+1));
  loadCategoryState();
  applyEditedQuestions();
  flashOrderMode = getSelectedQuizOrder();
  recomputeOrderedIds();
  renderAll(); updateExamUI();
}

// ---------- Render ----------
function renderAll(){ renderQuiz(); renderPagination(); renderSidePanel(); renderTinyStats(); updateFlashcardUI(); }

function renderQuiz(){
  const container = document.getElementById("quizContainer"); if(!container) return;
  const filtered = getFilteredQuestions();

  if (!currentCategory){
    container.innerHTML = `<div class="empty-hint"><div class="emoji">👈</div><p>Soldan bir kateqoriya seç</p></div>`;
    return;
  }
  if (!filtered.length){
    container.innerHTML = `<div class="empty-hint"><div class="emoji">🔍</div><p>Hələki loser deyilik (Hələki)</p></div>`;
    return;
  }

  const maskActive = (maskMode.active && !maskMode.cleared);

  questionsPerPage = singleQuestionMode ? 1 : baseQuestionsPerPage;
  const maxPage = Math.max(1, Math.ceil(filtered.length / questionsPerPage));
  if (currentPage > maxPage) currentPage = maxPage;

  const start = (currentPage-1)*questionsPerPage;
  const end = Math.min(start+questionsPerPage, filtered.length);
  const pageQuestions = filtered.slice(start, end);

  container.innerHTML = "";
  pageQuestions.forEach((q)=>{
    const card = document.createElement("div");
    card.className = "question"; card.id = "question-"+q.id;

    const header = document.createElement("div"); header.className = "question-header";
    const title = document.createElement("div");
    const num = document.createElement("span"); num.className="question-number"; num.textContent = q.id+".";
    const tt = document.createElement("span"); tt.textContent = q.question;
    title.appendChild(num); title.appendChild(tt);

    const meta = document.createElement("div"); meta.className="question-meta";
    const wc = questionWrongCount[q.id]||0; if (wc>0){ const s=document.createElement("span"); s.innerHTML=`<i class="fa fa-fire"></i> ${wc} səhv`; meta.appendChild(s); }
    if (flaggedQuestions.includes(q.id)){ const s=document.createElement("span"); s.innerHTML=`<i class="fa fa-flag"></i> flag`; meta.appendChild(s); }
    if (editedQuestions[q.id]){ const s=document.createElement("span"); s.innerHTML=`<i class="fa fa-pen"></i> dəyişib`; meta.appendChild(s); }

    header.appendChild(title); header.appendChild(meta); card.appendChild(header);

    const answersDiv = document.createElement("div"); answersDiv.className="answers";

    // MASK: wrong/flagged daxilində ilk açılışda cavab gizlədilir; klikdən sonra görünür
    const info = maskActive ? null : selectedAnswers[q.id];
    const selIdx = _resolveSelectedIndex(q, info);

    q.answers.forEach((ans, idx)=>{
      const btn = document.createElement("button"); btn.className="answer-btn";
      const letter = document.createElement("span"); letter.className="answer-letter"; letter.textContent=String.fromCharCode(65+idx);
      const text = document.createElement("span"); text.textContent = ans;
      btn.appendChild(letter); btn.appendChild(text);
      if (info){
        if (exam.running){ if (idx===selIdx) btn.classList.add("exam-selected"); }
        else if (idx===selIdx){ (idx===q.correctIndex?btn.classList.add("correct"):btn.classList.add("wrong")); }
      }
      btn.addEventListener("click", ()=> onAnswerClick(q.id, idx));
      answersDiv.appendChild(btn);
    });
    card.appendChild(answersDiv);

    const footer = document.createElement("div"); footer.className="question-footer";
    const actions = document.createElement("div"); actions.className="question-actions";

    const flagBtn = document.createElement("button"); flagBtn.className="icon-btn"; if (flaggedQuestions.includes(q.id)) flagBtn.classList.add("flagged");
    flagBtn.innerHTML = `<i class="fa fa-flag"></i> Flag`; flagBtn.addEventListener("click", ()=> toggleFlag(q.id)); actions.appendChild(flagBtn);

    const showBtn = document.createElement("button"); showBtn.className="icon-btn";
    showBtn.innerHTML = `<i class="fa fa-check-circle"></i> Düzgün cavab`; showBtn.addEventListener("click", ()=> toggleCorrectAnswer(q.id)); actions.appendChild(showBtn);

    const noteBtn = document.createElement("button"); noteBtn.className="icon-btn"; if (questionNotes[q.id]) noteBtn.classList.add("has-note");
    noteBtn.innerHTML = `<i class="fa fa-sticky-note"></i> Qeyd`; noteBtn.addEventListener("click", ()=> toggleNoteEditor(q.id)); actions.appendChild(noteBtn);

    if (wrongQuestions.includes(q.id)){
      const rmWrongBtn = document.createElement("button"); rmWrongBtn.className="icon-btn";
      rmWrongBtn.innerHTML=`<i class="fa fa-minus-circle"></i> Səhv siyahısından çıxar`; rmWrongBtn.addEventListener("click", ()=> removeFromWrong(q.id)); actions.appendChild(rmWrongBtn);
    }

    const editBtn = document.createElement("button"); editBtn.className="icon-btn admin-only";
    editBtn.innerHTML = `<i class="fa fa-pen"></i> Redaktə (admin)`; editBtn.addEventListener("click", ()=> editQuestion(q.id)); actions.appendChild(editBtn);

    footer.appendChild(actions);

    const infoPillWrap = document.createElement("div");
    const pill = document.createElement("span"); pill.className="note-pill";
    if (exam.running) pill.textContent="İmtahan gedir – nəticə imtahandan sonra görünəcək.";
    else if (info && selIdx!==-1) pill.textContent = (selIdx===q.correctIndex) ? "✅ Düzgün cavab vermisən" : "❌ Bu sualda səhvin var idi";
    else pill.textContent = maskActive ? "Bu baxışda cavablar gizlədilib" : "Cavab seçmək üçün variantlardan birinə kliklə";
    infoPillWrap.appendChild(pill);
    footer.appendChild(infoPillWrap);

    card.appendChild(footer);

    const noteBlock = document.createElement("div"); noteBlock.id="note-"+q.id; noteBlock.className="note-block";
    const existingNote = questionNotes[q.id] || ""; if (existingNote) noteBlock.classList.add("open");
    noteBlock.innerHTML = `<textarea placeholder="Qeyd..." rows="2">${existingNote}</textarea><button type="button" class="note-save-btn">Qeydi yadda saxla</button>`;
    const textarea = noteBlock.querySelector("textarea"); const saveBtn = noteBlock.querySelector("button");
    saveBtn.addEventListener("click", ()=>{
      const val = textarea.value.trim(); if (val) questionNotes[q.id]=val; else delete questionNotes[q.id];
      saveCategoryState(); renderAll();
    });
    card.appendChild(noteBlock);

    const correctDiv = document.createElement("div"); correctDiv.id="correct-answer-"+q.id; correctDiv.className="correct-answer-text";
    correctDiv.textContent = "Düzgün cavab: " + (q.answers[q.correctIndex]||"");
    card.appendChild(correctDiv);

    if (singleQuestionMode){
      const hint = document.createElement("div"); hint.className="swipe-hint"; hint.innerHTML="◀️ sağa/sola sürüşdür: növbəti/əvvəlki";
      card.appendChild(hint);
    }

    card.addEventListener("click", ()=> setActiveQuestion(q.id, {scroll:false}));
    container.appendChild(card);
  });
  const idsOnPage = pageQuestions.map(q=>q.id);
  if (!activeQuestionId || !idsOnPage.includes(activeQuestionId)){
    activeQuestionId = idsOnPage[0];
  }
  setActiveQuestion(activeQuestionId, {scroll:false});
}

function renderPagination(){
  const nav = document.getElementById("pageNavigation"); if(!nav) return;
  const filtered = getFilteredQuestions(); if (!filtered.length || !currentCategory){ nav.innerHTML=""; return; }
  const maxPage = Math.max(1, Math.ceil(filtered.length / questionsPerPage));
  const frag = document.createDocumentFragment();
  for (let p=1;p<=maxPage;p++){
    const btn = document.createElement("button"); btn.textContent = p;
    if (p===currentPage) btn.classList.add("active");
    btn.addEventListener("click", ()=>{ currentPage=p; persistProgress(); renderAll(); const top=document.querySelector(".quiz-container"); if(top) top.scrollIntoView({behavior:"smooth"}); });
    frag.appendChild(btn);
  }
  nav.innerHTML=""; nav.appendChild(frag);
}

function renderSidePanel(){
  const statsDiv = document.getElementById("statsInfo");
  const wrongList = document.getElementById("wrongQuestionsList");
  const flaggedList = document.getElementById("flaggedQuestionsList");
  const notedList = document.getElementById("notedQuestionsList");
  const repeatedList = document.getElementById("repeatedMistakesList");
  const editedList = document.getElementById("editedQuestionsList");

  const s = computeStats();
  if (statsDiv){
    statsDiv.innerHTML = `
      <span class="label">Ümumi sual:</span><span class="value">${s.total}</span>
      <span class="label">Cavab verdiyin:</span><span class="value">${s.answered}</span>
      <span class="label">Düzgün:</span><span class="value" style="color:var(--success);">${s.correct}</span>
      <span class="label">Səhv:</span><span class="value" style="color:var(--danger);">${s.wrong}</span>
      <span class="label">Flag:</span><span class="value">${s.flagged}</span>
    `;
  }

  if (wrongList){
    wrongList.innerHTML=""; 
    if (!wrongQuestions.length){ wrongList.classList.add("empty"); wrongList.textContent="Səhv sual yoxdur 🎉"; }
    else {
      wrongList.classList.remove("empty");
      wrongQuestions.forEach(id=>{ const b=document.createElement("button"); b.className="mini-pill"; b.textContent="#"+id; b.addEventListener("click",()=>scrollToQuestion(id)); wrongList.appendChild(b); });
    }
  }

  if (flaggedList){
    flaggedList.innerHTML="";
    if (!flaggedQuestions.length){ flaggedList.classList.add("empty"); flaggedList.textContent="Heç bir sual işarələnməyib"; }
    else {
      flaggedList.classList.remove("empty");
      flaggedQuestions.forEach(id=>{ const b=document.createElement("button"); b.className="mini-pill"; b.textContent="#"+id; b.addEventListener("click",()=>scrollToQuestion(id)); flaggedList.appendChild(b); });
    }
  }

  if (notedList){
    notedList.innerHTML="";
    const ids = Object.keys(questionNotes||{}).map(Number).sort((a,b)=>a-b);
    if (!ids.length){ notedList.classList.add("empty"); notedList.textContent="Qeyd olan sual yoxdur"; }
    else {
      notedList.classList.remove("empty");
      ids.forEach(id=>{ const b=document.createElement("button"); b.className="mini-pill"; b.textContent="#"+id; b.addEventListener("click",()=>scrollToQuestion(id)); notedList.appendChild(b); });
    }
  }

  if (repeatedList){
    repeatedList.innerHTML="";
    const rep = Object.entries(questionWrongCount||{}).filter(([_,c])=>c>=2).map(([id,c])=>({id:Number(id), c}));
    if (!rep.length){ repeatedList.classList.add("empty"); repeatedList.textContent="Təkrar səhv etdiyin sual yoxdur"; }
    else {
      repeatedList.classList.remove("empty");
      rep.sort((a,b)=>b.c-a.c).forEach(it=>{ const b=document.createElement("button"); b.className="mini-pill"; b.textContent=`#${it.id} · ${it.c} dəfə`; b.addEventListener("click",()=>scrollToQuestion(it.id)); repeatedList.appendChild(b); });
    }
  }

  if (editedList){
    editedList.innerHTML="";
    const entries = Object.values(editedQuestions||{}).sort((a,b)=>a.id-b.id);
    if (!entries.length){ editedList.classList.add("empty"); editedList.textContent=""; }
    else {
      editedList.classList.remove("empty");
      entries.forEach(e=>{
        const wrap=document.createElement("div"); wrap.className="edited-item";
        const header=document.createElement("div"); header.className="edited-header";
        const left=document.createElement("div"); left.textContent="Sual #"+e.id;
        const right=document.createElement("div"); right.textContent= e.active==="after" ? "Aktiv: yeni versiya" : "Aktiv: orijinal";
        header.appendChild(left); header.appendChild(right); wrap.appendChild(header);
        const diff=document.createElement("div"); diff.className="edited-diff";
        diff.innerHTML = "<b>Köhnə:</b> "+truncate(e.before.question,40)+"<br/><b>Yeni:</b> "+truncate(e.after.question,40);
        wrap.appendChild(diff);
        const btn=document.createElement("button"); btn.className="edited-switch-btn";
        btn.textContent = e.active==="after" ? "Orijinalı bərpa et" : "Dəyişmiş versiyanı aktiv et";
        btn.addEventListener("click",()=>toggleEditedVersion(e.id));
        wrap.appendChild(btn);
        editedList.appendChild(wrap);
      });
    }
  }
}

function renderTinyStats(){
  const s = computeStats();
  const t=document.getElementById("tinyTotal"); const a=document.getElementById("tinyAnswered"); const c=document.getElementById("tinyCorrect");
  if (t) t.textContent = s.total; if (a) a.textContent = s.answered; if (c) c.textContent = s.correct;
}

// ---------- Exam ----------
function updateExamUI(){
  const statusEl = document.getElementById("examStatusText");
  const timerEl = document.getElementById("examTimer");
  const startBtn = document.getElementById("examStartBtn");
  const finishBtn = document.getElementById("examFinishBtn");
  const summaryEl = document.getElementById("examSummary");
  if (!statusEl || !timerEl || !startBtn || !finishBtn || !summaryEl) return;

  if (!currentCategory) statusEl.textContent = "Əvvəlcə soldan bir kateqoriya seç.";
  else if (exam.running) statusEl.textContent = "İmtahan gedir...";
  else if (exam.lastResult) statusEl.textContent = "İmtahan bitdi. Nəticələr aşağıdadır.";
  else statusEl.textContent = "Praktika rejimindəsən və ya imtahana başla.";

  if (!currentCategory){ timerEl.classList.add("hidden"); startBtn.classList.add("hidden"); finishBtn.classList.add("hidden"); }
  else if (exam.running){ timerEl.classList.remove("hidden"); startBtn.classList.add("hidden"); finishBtn.classList.remove("hidden"); }
  else { timerEl.classList.remove("hidden"); startBtn.classList.remove("hidden"); finishBtn.classList.add("hidden"); }

  if (!exam.running) timerEl.textContent = formatTime(exam.durationSec);

  if (exam.lastResult){
    const { total, answered, correct, wrong } = exam.lastResult;
    summaryEl.classList.remove("hidden");
    summaryEl.innerHTML = `<div><strong>İmtahan nəticəsi</strong></div><div>Ümumi sual: ${total}</div><div>Cavab verdiyin: ${answered}</div><div>Düzgün: ${correct}</div><div>Səhv: ${wrong}</div>`;
  } else {
    updateSyncControlsUI(); summaryEl.classList.add("hidden"); summaryEl.innerHTML=""; }
}

function startExam(){
  if (!currentCategory){ alert("Əvvəlcə soldan bir kateqoriya seç."); return; }
  if (exam.running) return;
  const totalQuestions = allQuestions.length; if (!totalQuestions){ alert("Bu kateqoriyada sual tapılmadı."); return; }
  let minutesStr = prompt("İmtahan müddəti (dəqiqə):", "30"); if (minutesStr===null) return;
  let minutes = parseInt(minutesStr,10); if (isNaN(minutes)||minutes<=0) minutes=30;
  let countStr = prompt(`İmtahanda neçə sual olsun? (1 - ${totalQuestions})`, String(totalQuestions)); if (countStr===null) return;
  let qCount = parseInt(countStr,10); if (isNaN(qCount)||qCount<=0) qCount = totalQuestions; if (qCount>totalQuestions) qCount=totalQuestions;

  if (!confirm(`İmtahan başlayır: ${qCount} sual, ${minutes} dəqiqə.\nMövcud cavabların silinəcək. Davam edək?`)) return;

  exam.running = true; exam.lastResult = null; exam.durationSec = minutes*60;
  const shuffledIds = shuffleArray(allQuestions.map(q=>q.id));
  exam.questionIds = shuffledIds.slice(0, qCount);
  exam.endTime = Date.now() + exam.durationSec*1000;

  // Qeyd: İmtahan üçün hazırkı davranış cavabları təmizləyir (istəsən, bunu da maskaya çevirərik).
  selectedAnswers = {}; saveCategoryState();

  if (exam.timerId) clearInterval(exam.timerId);
  exam.timerId = setInterval(()=>{
    const now=Date.now(); let remaining = Math.max(0, Math.floor((exam.endTime-now)/1000));
    const timerEl = document.getElementById("examTimer"); if (timerEl) timerEl.textContent = formatTime(remaining);
    if (remaining<=0) finishExam(false);
  }, 1000);

  updateExamUI(); renderAll();
}
function finishExam(manual){
  if (!exam.running) return;
  exam.running = false; if (exam.timerId){ clearInterval(exam.timerId); exam.timerId=null; }
  let list = allQuestions;
  if (Array.isArray(exam.questionIds) && exam.questionIds.length){
    const set = new Set(exam.questionIds); list = allQuestions.filter(q=>set.has(q.id));
  }
  const total = list.length; let answered=0, correct=0, wrong=0;
  list.forEach((q)=>{
    const ans = selectedAnswers[q.id]; if (!ans) return;
    const idx = _resolveSelectedIndex(q, ans); if (idx===-1) return;
    answered++; if (idx===q.correctIndex) correct++; else wrong++;
  });
  exam.lastResult = { total, answered, correct, wrong };
  updateExamUI(); renderAll();
  if (manual) alert("İmtahan bitdi. Nəticəni yuxarıdakı paneldə görə bilərsən.");
}

// ---------- Actions ----------
function updateQuestionCardVisuals(id){
  const q = allQuestions.find(qq=>qq.id===id); if(!q) return;
  const card = document.getElementById("question-"+id); if(!card) return;

  const maskActive = (maskMode.active && !maskMode.cleared);

  const buttons = card.querySelectorAll(".answers .answer-btn");
  const info = maskActive ? null : selectedAnswers[id];
  const selIdx = _resolveSelectedIndex(q, info);

  buttons.forEach((btn, idx)=>{
    btn.classList.remove("correct","wrong","exam-selected");
    if (info){
      if (exam.running){ if (idx===selIdx) btn.classList.add("exam-selected"); }
      else if (idx===selIdx){ (idx===q.correctIndex?btn.classList.add("correct"):btn.classList.add("wrong")); }
    }
  });

  const pill = card.querySelector(".question-footer .note-pill");
  if (pill){
    if (exam.running) pill.textContent="İmtahan gedir – nəticə imtahandan sonra görünəcək.";
    else if (info && selIdx!==-1) pill.textContent = (selIdx===q.correctIndex) ? "✅ Düzgün cavab vermisən" : "❌ Bu sualda səhvin var idi";
    else pill.textContent = maskActive ? "Bu baxışda cavablar gizlədilib" : "Cavab seçmək üçün variantlardan birinə kliklə";
  }
}

function onAnswerClick(id, index){
  const q = allQuestions.find(qq=>qq.id===id); if (!q) return;

  // Dərhal yadda saxla
  selectedAnswers[id] = { index, value: q.answers[index], updatedAt: Date.now() };

  if (index !== q.correctIndex){
    if (!wrongQuestions.includes(id)) wrongQuestions.push(id);
    questionWrongCount[id] = (questionWrongCount[id]||0)+1;
  }
  saveCategoryState();

  // WRONG/FLAGGED rejimində ilk klikdə maskanı aç
  if (maskMode.active && !maskMode.cleared){
    maskMode.cleared = true; // WHY: həmin baxışda seçimin görünməsi üçün
  }

  updateQuestionCardVisuals(id);
  renderTinyStats(); renderSidePanel();
}

function toggleFlag(id){
  if (flaggedQuestions.includes(id)) flaggedQuestions = flaggedQuestions.filter(x=>x!==id);
  else flaggedQuestions.push(id);
  saveCategoryState(); renderSidePanel(); renderQuiz();
}
function removeFromWrong(id){
  if (!wrongQuestions.includes(id)) return;
  if (!confirm("Bu sualı 'səhv suallar' siyahısından çıxarmaq istəyirsən?")) return;
  wrongQuestions = wrongQuestions.filter(x=>x!==id);
  saveCategoryState(); renderAll();
}
function toggleCorrectAnswer(id){
  const el = document.getElementById("correct-answer-"+id); if (!el) return;
  el.classList.toggle("visible");
}
function toggleNoteEditor(id){
  const el = document.getElementById("note-"+id); if (!el) return;
  el.classList.toggle("open");
}
function scrollToQuestion(id){
  // Sanitize id like "677)" -> 677
  const m = String(id).match(/\d+/);
  if (!m) return;
  const qid = parseInt(m[0], 10);

  // Ensure navigation works across pages and even when filtered out
  const within = getFilteredQuestions();
  let idx = within.findIndex(q => q.id === qid);
  if (idx !== -1){
    const targetPage = Math.floor(idx / questionsPerPage) + 1;
    if (currentPage !== targetPage){
      currentPage = targetPage;
      renderAll();
    }
    requestAnimationFrame(()=>{
      setActiveQuestion(qid);
    });
    persistProgress();
    return;
  }

  // If not found due to filters/search, temporarily show all
  const exists = allQuestions.some(q => q.id === qid);
  if (!exists) return;
  const prevFilter = filterMode;
  const prevQuery  = searchQuery;
  filterMode = "all";
  searchQuery = "";
  recomputeOrderedIds();
  const allList = getFilteredQuestions();
  idx = allList.findIndex(q => q.id === qid);
  if (idx !== -1){
    currentPage = Math.floor(idx / questionsPerPage) + 1;
    renderAll();
    requestAnimationFrame(()=>{
      setActiveQuestion(qid);
    });
    persistProgress();
    return;
  }

  // Revert if somehow still not found
  filterMode = prevFilter;
  searchQuery = prevQuery;
}function toggleEditedVersion(id){
  const e = editedQuestions[id]; if(!e) return;
  const q = allQuestions.find(qq=>qq.id===id); if(!q) return;
  if (e.active==="after"){
    e.active="before"; q.question=e.before.question; q.answers=e.before.answers.slice(); q.correctIndex=e.before.correctIndex;
  } else {
    updateSyncControlsUI();
    e.active="after"; q.question=e.after.question; q.answers=e.after.answers.slice(); q.correctIndex=e.after.correctIndex;
  }
  delete selectedAnswers[id];
  saveCategoryState(); renderAll();
}

// Bu funksiya cavabları SİLMİR
function resetAnswersForCurrentFilter(){
  // no-op
}

function resetAllAnswersInCategory(){
  selectedAnswers = {}; saveCategoryState();
}

// ---------- Admin: EDIT QUESTION (ADDED) ----------
// filepath: /mnt/data/app.js
/* ==== QALAN KOD EYNİDİR — yalnız EDIT hissəsi aşağıda dəyişdirilib ==== */

// ... (yuxarıdakı bütün kod eyni saxlanılıb)

/* ---------- Admin: EDIT QUESTION (INLINE) ---------- */
function editQuestion(id){
  if (!isAdmin){ alert("Bu funksiya yalnız admin üçündür."); return; }

  const q = allQuestions.find(qq => qq.id === id);
  if (!q){ alert("Sual tapılmadı."); return; }

  const card = document.getElementById("question-"+id);
  if (!card){ alert("UI tapılmadı."); return; }
  if (card.querySelector(".edit-form")) return; // artıq açılıbsa

  // Mövcud hissələri gizlət
  const answersDiv = card.querySelector(".answers");
  const footer = card.querySelector(".question-footer");
  const noteBlock = card.querySelector("#note-"+id);
  const correctDiv = card.querySelector("#correct-answer-"+id);
  [answersDiv, footer, noteBlock, correctDiv].forEach(el=>{ if (el) el.style.display="none"; });

  // Inline editoru qur
  const form = buildInlineEditor(q, {
    onCancel: ()=>{
      if (answersDiv) answersDiv.style.display="";
      if (footer) footer.style.display="";
      if (noteBlock) noteBlock.style.display="";
      if (correctDiv) correctDiv.style.display="";
      form.remove();
    },
    onSave: (payload)=>{
      const { question, answers, correctIndex } = payload;

      // editedQuestions before/after yaz
      const curQ = q.question;
      const curAnswers = q.answers.slice();
      const curCorrect = q.correctIndex;

      if (!editedQuestions[id]){
        editedQuestions[id] = {
          id,
          active: "after",
          before: { question: curQ, answers: curAnswers, correctIndex: curCorrect },
          after:  { question, answers, correctIndex }
        };
      } else {
    updateSyncControlsUI();
        // first time if previous before is missing, ensure it's current
        if (!editedQuestions[id].before){
          editedQuestions[id].before = { question: curQ, answers: curAnswers, correctIndex: curCorrect };
        }
        editedQuestions[id].after = { question, answers, correctIndex };
        editedQuestions[id].active = "after";
      }

      // Live-a tətbiq et
      q.question = question;
      q.answers = answers.slice();
      q.correctIndex = correctIndex;

      delete selectedAnswers[id];
      saveCategoryState();

      // Kartı yenidən göstər
      renderAll();
    }
  });

  // Header-dən sonra daxil et
  const header = card.querySelector(".question-header");
  if (header && header.nextSibling) card.insertBefore(form, header.nextSibling);
  else card.appendChild(form);
}

// Köməkçi: inline editor UI
function buildInlineEditor(q, handlers){
  const form = document.createElement("div");
  form.className = "edit-form";
  form.style.border = "1px dashed var(--border)";
  form.style.borderRadius = "8px";
  form.style.padding = "12px";
  form.style.marginTop = "10px";
  form.style.background = "var(--panel-bg, rgba(0,0,0,0.03))";

  // Sual mətni
  const qLabel = document.createElement("div");
  qLabel.style.fontWeight = "600";
  qLabel.style.marginBottom = "6px";
  qLabel.textContent = "Sual mətni";
  const qInput = document.createElement("textarea");
  qInput.rows = 2;
  qInput.value = q.question || "";
  qInput.style.width = "100%";
  qInput.style.boxSizing = "border-box";
  qInput.style.marginBottom = "10px";

  // Cavab siyahısı wrapper
  const answersWrap = document.createElement("div");
  answersWrap.className = "edit-answers-wrap";

  // Header (radio + cavab + sil)
  const head = document.createElement("div");
  head.style.display = "grid";
  head.style.gridTemplateColumns = "24px 1fr 32px";
  head.style.gap = "8px";
  head.style.alignItems = "center";
  head.style.fontSize = "12px";
  head.style.opacity = "0.8";
  head.style.margin = "6px 0";
  head.innerHTML = `<span>✔</span><span>Cavab</span><span></span>`;

  answersWrap.appendChild(head);

  // Row yaradan helper
  const makeRow = (text, checked)=>{
    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "24px 1fr 32px";
    row.style.gap = "8px";
    row.style.alignItems = "center";
    row.style.marginBottom = "6px";

    const radio = document.createElement("input");
    radio.type = "radio"; radio.name = "correctAnswer";
    radio.checked = !!checked;

    const input = document.createElement("input");
    input.type = "text"; input.value = text || "";
    input.placeholder = "Cavab variantı";
    input.style.width = "100%";

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn";
    delBtn.innerHTML = `<i class="fa fa-trash"></i>`;
    delBtn.title = "Sətiri sil";
    delBtn.addEventListener("click", ()=>{
      // WHY: ən az 2 cavab şərtini qorumaq üçün sonradan yoxlanacaq
      row.remove();
    });

    row.appendChild(radio);
    row.appendChild(input);
    row.appendChild(delBtn);
    return row;
  };

  // Mövcud cavabları doldur
  if (Array.isArray(q.answers) && q.answers.length){
    q.answers.forEach((a, i)=>{
      answersWrap.appendChild(makeRow(a, i===q.correctIndex));
    });
  } else {
    updateSyncControlsUI();
    answersWrap.appendChild(makeRow("", true));
    answersWrap.appendChild(makeRow("", false));
  }

  // Variant əlavə et
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "icon-btn";
  addBtn.style.marginTop = "6px";
  addBtn.innerHTML = `<i class="fa fa-plus-circle"></i> Variant əlavə et`;
  addBtn.addEventListener("click", ()=>{
    answersWrap.appendChild(makeRow("", false));
  });

  // Action düymələri
  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "8px";
  actions.style.marginTop = "12px";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "icon-btn";
  cancelBtn.innerHTML = `<i class="fa fa-times"></i> İmtina`;
  cancelBtn.addEventListener("click", ()=> handlers.onCancel && handlers.onCancel());

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "icon-btn";
  saveBtn.innerHTML = `<i class="fa fa-save"></i> Yadda saxla`;
  saveBtn.addEventListener("click", ()=>{
    const question = (qInput.value||"").trim();
    const rows = Array.from(answersWrap.querySelectorAll("div")).filter(div=>div!==head);
    const answers = [];
    let correctIndex = -1;

    rows.forEach((row, idx)=>{
      const [radio, input] = row.querySelectorAll("input");
      const val = (input.value||"").trim();
      if (val){ answers.push(val); if (radio.checked) correctIndex = answers.length-1; }
    });

    if (!question){ alert("Sual mətni boş ola bilməz."); return; }
    if (answers.length < 2){ alert("Ən azı 2 cavab olmalıdır."); return; }
    if (correctIndex < 0){ alert("Düzgün cavabı seç."); return; }

    handlers.onSave && handlers.onSave({ question, answers, correctIndex });
  });

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  // Montaj
  form.appendChild(qLabel);
  form.appendChild(qInput);
  form.appendChild(answersWrap);
  form.appendChild(addBtn);
  form.appendChild(actions);

  return form;
}

// Inline handlerlərin globaldan çağırılması üçün
window.editQuestion = editQuestion;


function selectCategory(filename){
    // new salt on each category switch so answer order changes
  VIEW_SALT = (Math.random()*4294967296)>>>0;
currentCategory = filename;
  currentPage = 1;
  filterMode = "all"; restoreAllViewPage();
  maskMode = { active:false, cleared:false }; // yeni kateqoriyada maskanı sıfırla

  exam.running=false; exam.lastResult=null; exam.questionIds=[];
  if (exam.timerId){ clearInterval(exam.timerId); exam.timerId=null; }

  document.querySelectorAll(".category-btn").forEach(btn=>btn.classList.remove("selected"));
  const activeBtn = document.querySelector(`.category-btn[data-category="${filename}"]`);
  if (activeBtn) activeBtn.classList.add("selected");

  const container = document.getElementById("quizContainer");
  if (container) container.innerHTML = `<div class="empty-hint"><div class="emoji">⏳</div><p>Suallar yüklənir...</p></div>`;

  fetch(filename).then(r=>{
    if(!r.ok) throw new Error("Fayl tapılmadı");
    return r.json();
  }).then(data=>{
    allQuestions = (data||[]).map((q, idx)=>normalizeQuestion(q, idx+1));
    loadCategoryState();
    applyEditedQuestions();
    flashOrderMode = getSelectedQuizOrder();
    recomputeOrderedIds();
    renderAll(); updateExamUI();
  }).catch(e=>{
    console.error(e);
    if (container) container.innerHTML = `<div class="empty-hint"><div class="emoji">⚠️</div><p>Faylı yükləmək alınmadı: ${filename}</p></div>`;
  });
}

function getSelectedQuizOrder(){
  const r = document.querySelector('input[name="quizOrder"]:checked');
  return r ? r.value : 'sequential';
}

function resetCurrentCategory(){
  if (!currentCategory) return;
  if (!confirm("Bu kateqoriyadakı nəticələri sıfırlamaq istəyirsən? (Qeyd və flag saxlanacaq)")) return;

  selectedAnswers = {};
  wrongQuestions = [];
  questionWrongCount = {};
  editedQuestions = {};

  exam.running=false; exam.lastResult=null; exam.questionIds=[];
  if (exam.timerId){ clearInterval(exam.timerId); exam.timerId=null; }

  localStorage.removeItem(storageKey("selectedAnswers"));
  localStorage.removeItem(storageKey("wrongQuestions"));
  localStorage.removeItem(storageKey("questionWrongCount"));
  localStorage.removeItem(storageKey("editedQuestions"));

  recomputeOrderedIds(); renderAll(); updateExamUI();
}

function clearAllData(){
  if (!confirm("BÜTÜN məlumatlar silinəcək. Davam edək?")) return;
  if (!confirm("Əminsən? Bu əməliyyat geri qaytarılmır.")) return;
  localStorage.clear();
  exam.running=false; exam.lastResult=null; exam.questionIds=[];
  if (exam.timerId){ clearInterval(exam.timerId); exam.timerId=null; }
  location.reload();
}

// ---------- Admin / Theme ----------
function adminLoginPrompt(){
  const pwd = prompt("Admin parolu:"); if (pwd===null) return;
  if (pwd==="justmee"){ isAdmin=true; localStorage.setItem("quiz_isAdmin","true"); updateAdminButtonUI(); alert("Admin rejimi aktivdir."); }
  else alert("Yanlış parol.");
}
function toggleAdminFromButton(){
  if (isAdmin){ if (confirm("Admin rejimindən çıxmaq istəyirsən?")){ isAdmin=false; localStorage.setItem("quiz_isAdmin","false"); updateAdminButtonUI(); } }
  else adminLoginPrompt();
}
function updateAdminButtonUI(){
  const btn = document.getElementById("adminLoginBtn"); if(!btn) return;
  if (isAdmin){ btn.classList.add("admin-on"); btn.querySelector("span").textContent="Admin: ON"; }
  else { btn.classList.remove("admin-on"); btn.querySelector("span").textContent="Admin girişi"; }
}
function initDarkMode(){
  const darkBtn = document.getElementById("darkModeToggle"); if(!darkBtn) return;
  const saved = localStorage.getItem("quiz_darkMode"); if (saved==="on") document.body.classList.add("dark-mode");
  updateDarkButtonUI();
  darkBtn.addEventListener("click", ()=>{
    const isDark = document.body.classList.toggle("dark-mode");
    localStorage.setItem("quiz_darkMode", isDark ? "on" : "off");
    updateDarkButtonUI();
  });
}
function updateDarkButtonUI(){
  const darkBtn = document.getElementById("darkModeToggle"); if(!darkBtn) return;
  const icon = darkBtn.querySelector("i"); const span = darkBtn.querySelector("span");
  const isDark = document.body.classList.contains("dark-mode");
  if (icon) icon.className = isDark ? "fa fa-sun" : "fa fa-moon";
  if (span) span.textContent = isDark ? "İşıqlı rejim" : "Qaranlıq rejim";
}

// ---------- Flashcard ----------
function updateFlashcardUI(){
  const controls = document.getElementById("flashcardControls"); const body=document.body;
  if (singleQuestionMode){ body.classList.add("flashcard-mode"); if (controls) controls.classList.remove("hidden"); }
  else { body.classList.remove("flashcard-mode"); if (controls) controls.classList.add("hidden"); }
  const filtered = getFilteredQuestions(); const counter = document.getElementById("cardCounter");
  if (counter && filtered.length){ counter.textContent = `${currentPage}/${Math.max(1, Math.ceil(filtered.length / questionsPerPage))}`; }
}
function goNextCard(){ const f=getFilteredQuestions(); const max=Math.max(1, Math.ceil(f.length/questionsPerPage)); currentPage=Math.min(max,currentPage+1); persistProgress(); renderAll(); }
function goPrevCard(){ currentPage=Math.max(1,currentPage-1); persistProgress(); renderAll(); }
function attachSwipeHandlers(){
  const area=document.getElementById("quizContainer"); if(!area) return;
  let sx=0, sy=0, active=false;
  area.addEventListener("touchstart",(e)=>{ if(!singleQuestionMode) return; active=true; const t=e.touches[0]; sx=t.clientX; sy=t.clientY; },{passive:true});
  area.addEventListener("touchend",(e)=>{ if(!singleQuestionMode||!active) return; const t=e.changedTouches[0]; const dx=t.clientX-sx, dy=t.clientY-sy;
    if (Math.abs(dx)>40 && Math.abs(dy)<40){ if (dx<0) goNextCard(); else goPrevCard(); }
    active=false;
  });
  document.addEventListener("keydown",(e)=>{ if(!singleQuestionMode) return; if(e.key==="ArrowRight") goNextCard(); else if(e.key==="ArrowLeft") goPrevCard(); });
}

// ---------- PWA ----------
let deferredPrompt=null;
function initPWAInstall(){
  const btn=document.getElementById('installBtn');
  const show=()=>{ if(btn) btn.classList.remove('hidden'); };
  const hide=()=>{ if(btn) btn.classList.add('hidden'); };
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isStandalone) hide();
  window.addEventListener('beforeinstallprompt',(e)=>{ e.preventDefault(); deferredPrompt=e; show(); });
  window.addEventListener('appinstalled', hide);
  if (btn){
    btn.addEventListener('click', async ()=>{
      if (!deferredPrompt){ return; }
      deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; hide();
    });
  }
}

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", ()=>{

  // ==== FOCUS MODE toggle + Exit FAB ====
  
  (function(){
    
    const KEY="ui_focus_mode";
    const btn = document.getElementById("focusModeBtn");
    let fab = document.getElementById("focusExitFab");
    if (!fab){
      fab = document.createElement("button");
      fab.id = "focusExitFab";
      fab.className = "floating-focus-btn";
      fab.textContent = "⤫ Exit Focus";
      document.body.appendChild(fab);
    }
    
    const apply=(on)=>{
      document.body.classList.toggle("focus-mode", !!on);
      if (btn) btn.classList.toggle("active", !!on);
    };
    apply(localStorage.getItem(KEY)==="1");
    const toggle=()=>{
      const on = !document.body.classList.contains("focus-mode");
      localStorage.setItem(KEY, on ? "1":"0");
      apply(on);
      // center active card
      if (on && typeof activeQuestionId!=="undefined" && activeQuestionId!=null){
        const el = document.getElementById("question-"+activeQuestionId);
        if (el) el.scrollIntoView({behavior:"smooth", block:"center"});
      }
    };
    if (btn && !btn.__wired){ btn.__wired=true; btn.addEventListener("click", toggle); }
    if (fab && !fab.__wired){ fab.__wired=true; fab.addEventListener("click", ()=>{ localStorage.setItem(KEY,"0"); apply(false); }); }
    document.addEventListener("keydown", (e)=>{
      if (e.key==="Escape" && document.body.classList.contains("focus-mode")){
        e.preventDefault(); localStorage.setItem(KEY,"0"); apply(false);
      }
    });
  })();


  // ==== SIMPLE NOTES (per-category, single textarea) ====
(function(){
  // WHY: notes hər kateqoriya üçün ayrıca saxlanılsın
  function notesKey(){ 
    // storageKey avtomatik "quiz_<category>_<name>" qurur
    return storageKey("user_notes_text"); 
  }

  function ensure(){
    if (document.getElementById("simpleNotesOverlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "simpleNotesOverlay";
    overlay.style.cssText = "position:fixed;inset:0;display:none;z-index:2100;align-items:center;justify-content:center;background:rgba(2,6,23,.5);backdrop-filter:blur(2px)";
    overlay.innerHTML = `
      <div style="width:min(980px,94vw);max-height:86vh;background:#fff;color:inherit;border-radius:18px;overflow:hidden;border:1px solid var(--border);box-shadow:0 28px 70px rgba(2,6,23,.3);display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);">
          <strong>📝 Notes (şəxsi)</strong>
          <div style="display:flex;gap:8px;align-items:center;">
            <button id="simpleNotesExport" class="secondary-btn"><i class="fa fa-download"></i> Export</button>
            <button id="simpleNotesClear" class="secondary-btn"><i class="fa fa-eraser"></i> Təmizlə</button>
            <button id="simpleNotesClose" class="icon-btn">✕</button>
          </div>
        </div>
        <div style="padding:12px;">
          <div contenteditable="true" id="simpleNotesEditor" style="border:1px solid var(--border);border-radius:12px;min-height:360px;padding:12px;background:#fff;color:inherit;"></div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
            <span id="simpleNotesSaved" class="note-pill"></span>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const ed = overlay.querySelector("#simpleNotesEditor");

    // İlk yükləmə: cari kateqoriyanın notunu göstər
    const loadForCategory = ()=>{
      const saved = localStorage.getItem(notesKey()) || "";
      ed.innerHTML = saved || "<p></p>";
    };
    loadForCategory();

    // Debounced save (kateqoriya-özəl açara)
    let t;
    const saveNow = ()=>{
      try{
        localStorage.setItem(notesKey(), ed.innerHTML);
        const pill = overlay.querySelector("#simpleNotesSaved");
        if (pill){ pill.textContent="Yadda saxlandı ✓"; setTimeout(()=> pill.textContent="", 1200); }
      }catch{}
    };
    const onInput = ()=>{ clearTimeout(t); t=setTimeout(saveNow, 500); };
    ed.addEventListener("input", onInput);

    overlay.querySelector("#simpleNotesClear").addEventListener("click", ()=>{
      if (confirm("Bu kateqoriyanın bütün qeydləri silinsin?")){
        ed.innerHTML="<p></p>";
        saveNow(); // WHY: silinməni həmin kateqoriyaya yaz
      }
    });

    overlay.querySelector("#simpleNotesExport").addEventListener("click", ()=>{
      const blob = new Blob([ed.innerHTML], {type:"text/html"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
      const cat = (currentCategory || "GLOBAL").replace(/[^\w\-]+/g, "_");
      a.href = url; a.download = `notes_${cat}_${ts}.html`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    });

    const hide = ()=>{ overlay.style.display="none"; };
    overlay.addEventListener("click", (e)=>{ if (e.target===overlay) hide(); });
    overlay.querySelector("#simpleNotesClose").addEventListener("click", hide);

    // Hər açılışda cari kateqoriyanın mətni yenidən yüklə
    window.__openSimpleNotes = ()=>{ 
      overlay.style.display="flex"; 
      loadForCategory(); // WHY: kateqoriya dəyişəndə fərqli açarı oxu
      ed.focus(); 
    };
  }

  // Modal hazırla
  ensure();

  // Açma düyməsi (mövcud düyməni eyni saxlayırıq)
  const btn = document.getElementById("openNotesBtn");
  if (btn){
    btn.addEventListener("click", (e)=>{
      e.preventDefault(); e.stopImmediatePropagation();
      if (window.__openSimpleNotes) window.__openSimpleNotes();
    });
  }
})();


  // ==== NOTES MODAL (per-category persistent notes manager) ====
  (function(){
    const ensureModal = () => {
      if (document.getElementById("notesModalOverlay")) return;
      const overlay = document.createElement("div");
      overlay.id = "notesModalOverlay";
      overlay.innerHTML = `
        <div id="notesModal">
          <div class="notes-header">
            <div class="title">📝 Qeydlər · <span id="notesCatLabel">—</span></div>
            <div class="notes-actions">
              <input id="notesSearch" type="text" placeholder="Axtar: sual mətni və ya qeyddə..." />
              <button id="notesExport" class="secondary-btn"><i class="fa fa-download"></i> Export</button>
              <button id="notesClose" title="Bağla">✕</button>
            </div>
          </div>
          <div id="notesBody" class="notes-body"></div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (e)=>{ if (e.target === overlay) hide(); });
      document.getElementById("notesClose").addEventListener("click", hide);
      document.getElementById("notesExport").addEventListener("click", exportNotes);
      document.getElementById("notesSearch").addEventListener("input", renderList);
    };

    function show(){
      ensureModal();
      const overlay = document.getElementById("notesModalOverlay");
      overlay.style.display = "flex";
      renderList();
    }
    function hide(){
      const overlay = document.getElementById("notesModalOverlay");
      if (overlay) overlay.style.display = "none";
    }

    function exportNotes(){
      const data = questionNotes || {};
      const blob = new Blob([JSON.stringify({ category: currentCategory, notes: data }, null, 2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      a.href = url; a.download = `notes_${(currentCategory||'GLOBAL')}_${ts}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }

    function renderList(){
      const body = document.getElementById("notesBody");
      const search = (document.getElementById("notesSearch").value || "").toLowerCase().trim();
      const catLabel = document.getElementById("notesCatLabel");
      if (catLabel) catLabel.textContent = currentCategory || "—";

      const ids = Object.keys(questionNotes||{}).map(Number).sort((a,b)=>a-b);
      if (!ids.length){
        body.innerHTML = `<div class="notes-empty">Bu kateqoriya üçün qeyd yoxdur.</div>`;
        return;
      }
      const frag = document.createDocumentFragment();
      ids.forEach(id=>{
        const q = (allQuestions||[]).find(qq=>qq.id===id);
        const note = (questionNotes||{})[id] || "";
        if (search){
          const hay = (String(q && q.question || "") + " " + note).toLowerCase();
          if (!hay.includes(search)) return;
        }
        const item = document.createElement("div");
        item.className = "notes-item";

        const idCol = document.createElement("div");
        idCol.className = "notes-id";
        idCol.textContent = "#" + id;

        const textCol = document.createElement("div");
        textCol.className = "notes-text";
        const qTxt = document.createElement("div");
        qTxt.style.fontSize = "0.85rem";
        qTxt.style.color = "var(--text-muted)";
        qTxt.textContent = q ? q.question : "(Sual tapılmadı)";
        const ta = document.createElement("textarea");
        ta.value = note;
        textCol.appendChild(qTxt); textCol.appendChild(ta);

        const ops = document.createElement("div");
        ops.className = "notes-ops";
        const saveBtn = document.createElement("button");
        saveBtn.className = "icon-btn"; saveBtn.innerHTML = `<i class="fa fa-save"></i> Yadda saxla`;
        saveBtn.addEventListener("click", ()=>{
          const v = ta.value.trim();
          if (v) questionNotes[id] = v; else delete questionNotes[id];
          saveCategoryState(); renderList(); renderSidePanel();
        });
        const goBtn = document.createElement("button");
        goBtn.className = "icon-btn"; goBtn.innerHTML = `<i class="fa fa-arrow-right"></i> Keç`;
        goBtn.addEventListener("click", ()=>{ hide(); scrollToQuestion(id); });
        ops.appendChild(saveBtn); ops.appendChild(goBtn);

        item.appendChild(idCol);
        item.appendChild(textCol);
        item.appendChild(ops);
        frag.appendChild(item);
      });
      body.innerHTML = ""; body.appendChild(frag);
    }

    const openBtn = document.getElementById("openNotesBtn");
    if (openBtn && !openBtn.__wired){
      openBtn.__wired = true;
      openBtn.addEventListener("click", show);
    }

    // Expose to window for potential calls
    window.showNotesModal = show;
    window.hideNotesModal = hide;
  })();

  const _mixEdit = document.getElementById("mixEditBtn");
  if (_mixEdit){ _mixEdit.addEventListener("click", (e)=>{ e.preventDefault(); e.stopPropagation(); showAllMixEditor(); }); }

  (function(){
    if (!document.getElementById("kbd-active-style")){
      const st=document.createElement("style"); st.id="kbd-active-style"; st.textContent=".question.active{outline:2px solid var(--primary, #3b82f6); box-shadow:0 0 0 3px rgba(59,130,246,.25);}"; document.head.appendChild(st);
    }
  })();
  initFirebaseAuth();

  // Keyboard navigation: Up/Down, Enter, F
  document.addEventListener("keydown", (e)=>{
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
    const editable = e.target && (e.target.isContentEditable || tag==="input" || tag==="textarea" || tag==="select");
    if (editable) return;
    if (e.key === "ArrowDown"){ e.preventDefault(); moveActive(1); return; }
    if (e.key === "ArrowUp"){ e.preventDefault(); moveActive(-1); return; }
    if (e.key === "Enter"){ if (activeQuestionId!=null){ e.preventDefault(); toggleCorrectAnswer(activeQuestionId); } return; }
    if ((e.key||"").toLowerCase() === "f"){ if (activeQuestionId!=null){ e.preventDefault(); toggleFlag(activeQuestionId); } return; }
    // Space toggles correct answer panel
    if (e.code === "Space" || e.key === " "){ if (activeQuestionId!=null){ e.preventDefault(); toggleCorrectAnswer(activeQuestionId); } return; }
    // Numeric keys 1-9 choose corresponding option
    if (/^[1-9]$/.test(e.key)){ if (activeQuestionId!=null){ e.preventDefault(); chooseOptionByIndex(activeQuestionId, parseInt(e.key,10)-1); } return; }

  });

  const prevBtn=document.getElementById("prevCard");
  const nextBtn=document.getElementById("nextCard");
  if (prevBtn) prevBtn.addEventListener("click", ()=>{ goPrevCard(); updateFlashcardUI(); });
  if (nextBtn) nextBtn.addEventListener("click", ()=>{ goNextCard(); updateFlashcardUI(); });

  const floatFlashBtn=document.getElementById("flashcardFloatingToggle");
  if (floatFlashBtn){
    const syncLabel=()=>{ floatFlashBtn.textContent = "🗂️ " + (singleQuestionMode?"Flashcard ON":"Flashcard"); };
    syncLabel();
    floatFlashBtn.addEventListener("click", ()=>{
      singleQuestionMode = !singleQuestionMode;
      const sqToggleEl = document.getElementById("singleQuestionModeToggle");
      if (sqToggleEl) sqToggleEl.checked = singleQuestionMode;
      flashOrderMode = getSelectedQuizOrder();
      questionsPerPage = singleQuestionMode ? 1 : baseQuestionsPerPage;
      if (singleQuestionMode){ restoreFlashPage(); } else { if (filterMode==="all") restoreAllViewPage(); else currentPage=1; } window.__suppressPageReset=true; recomputeOrderedIds(); window.__suppressPageReset=false; persistProgress(); renderAll(); updateFlashcardUI(); syncLabel(); }) ;
  }

  const startBtn=document.getElementById("startBtn");
  const welcome=document.getElementById("welcomeScreen");
  const main=document.getElementById("mainContent");
  if (startBtn && welcome && main){
    startBtn.addEventListener("click", ()=>{
      const fbtn=document.getElementById('flashcardFloatingToggle'); if (fbtn) fbtn.classList.remove('hidden');
      welcome.style.display="none"; main.style.display="block";
      const evt=new Event("app-started"); document.dispatchEvent(evt);
      const floatBtn=document.getElementById("flashcardFloatingToggle"); if (floatBtn) floatBtn.classList.remove("hidden");
    });
  }

  document.querySelectorAll(".category-btn").forEach((btn)=>{
    btn.addEventListener("click", ()=>{ const file=btn.getAttribute("data-category"); if(!file) return; if(file==="__ALL__"){ selectAllMixedCategory(); } else { selectCategory(file); } });
  });

  // Filtr düymələri → maskanı qur
  document.querySelectorAll(".quiz-filter-btn").forEach((btn)=>{
    btn.addEventListener("click", ()=>{
      const mode = btn.getAttribute("data-filter") || "all";
      filterMode = mode;
      // Yalnız wrong/flagged üçün maskanı aktivləşdir, cleared=false
      maskMode.active  = (mode === "wrong" || mode === "flagged");
      maskMode.cleared = false;

      document.querySelectorAll(".quiz-filter-btn").forEach(b=> b.classList.toggle("active", b===btn));
      if (mode==="all" && !singleQuestionMode) { restoreAllViewPage(); } else { currentPage=1; } window.__suppressPageReset=true; recomputeOrderedIds(); window.__suppressPageReset=false; persistProgress(); renderAll();
    });
  });

  const select = document.getElementById("questionsPerPage");
  if (select){
    const saved = parseInt(localStorage.getItem("quiz_questionsPerPage")||"10",10);
    if (!isNaN(saved)){ baseQuestionsPerPage=saved; questionsPerPage=saved; select.value=String(saved); }
    select.addEventListener("change", ()=>{
      const v=parseInt(select.value,10); baseQuestionsPerPage=isNaN(v)?10:v;
      localStorage.setItem("quiz_questionsPerPage", String(baseQuestionsPerPage));
      if (!singleQuestionMode) questionsPerPage = baseQuestionsPerPage;
      currentPage=1; recomputeOrderedIds(); renderAll();
    });
  }

  const sqToggle=document.getElementById("singleQuestionModeToggle");
  if (sqToggle){
    sqToggle.addEventListener("change", ()=>{
      singleQuestionMode = sqToggle.checked;
      flashOrderMode = getSelectedQuizOrder();
      questionsPerPage = singleQuestionMode ? 1 : baseQuestionsPerPage;
      currentPage=1; recomputeOrderedIds(); renderAll();
    });
  }

  document.querySelectorAll('input[name="quizOrder"]').forEach(r=>{
    r.addEventListener('change', ()=>{
      renderAll();
      flashOrderMode = getSelectedQuizOrder();
      if (singleQuestionMode){ recomputeOrderedIds(); renderAll(); }
    });
  });

  const searchInput=document.getElementById("searchInput");
  if (searchInput){
    searchInput.addEventListener("input", ()=>{
      searchQuery = searchInput.value||""; currentPage=1; recomputeOrderedIds(); renderAll();
    });
  }

  const resetBtn=document.getElementById("categoryResetBtn"); if (resetBtn) resetBtn.addEventListener("click", resetCurrentCategory);
  const clearBtn=document.getElementById("clearAllBtn"); if (clearBtn) clearBtn.addEventListener("click", clearAllData);

  const sideToggle=document.getElementById("sidePanelToggle");
  if (sideToggle) sideToggle.addEventListener("click", ()=> document.body.classList.toggle("side-collapsed"));

  const examStartBtn=document.getElementById("examStartBtn");
  if (examStartBtn){ examStartBtn.classList.remove("hidden"); examStartBtn.addEventListener("click", ()=> startExam()); }
  const examFinishBtn=document.getElementById("examFinishBtn");
  if (examFinishBtn){ examFinishBtn.addEventListener("click", ()=>{ if(!exam.running) return; if(!confirm("İmtahanı bitirmək istəyirsən?")) return; finishExam(true); }); }
  updateExamUI();

  const adminBtn=document.getElementById("adminLoginBtn"); if (adminBtn) adminBtn.addEventListener("click", toggleAdminFromButton);
  isAdmin = localStorage.getItem("quiz_isAdmin")==="true"; updateAdminButtonUI();

  initDarkMode();
  renderTinyStats();
  attachSwipeHandlers();

  if ("serviceWorker" in navigator){
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
  initPWAInstall();

  flashOrderMode = getSelectedQuizOrder();



  // ==== Sync controls (init after DOM ready) ====
  try{ initSyncControlsUI(); updateSyncControlsUI(); }catch{}

});

// Mobile helper
function toggleMobileMode(){ document.body.classList.toggle('flashcard-mode'); }
// ---------- Cloud Edited Questions (Firebase) — preview & apply (ADDED) ----------
function _getRemoteEditedForCurrentCategory(remoteData){
  try{
    const data = remoteData && remoteData.data ? remoteData.data : (remoteData || {});
    const key = storageKey("editedQuestions");
    const raw = data[key];
    const map = (typeof raw === "string") ? _parseJSONMaybe(raw) : raw;
    return (map && typeof map === "object") ? map : {};
  }catch{ return {}; }
}

function renderCloudEditedList(remoteEditedMap, updatedAt){
  const list = document.getElementById("cloudEditedQuestionsList");
  const status = document.getElementById("cloudStatus");
  if (status){
    try{
      const ts = updatedAt && updatedAt.toDate ? updatedAt.toDate().getTime() : updatedAt;
      status.textContent = "Bulud · " + (ts ? prettyTime(ts) : "—");
    }catch{ status.textContent = "Bulud · —"; }
  }
  if (!list) return;
  list.innerHTML = "";
  const entries = Object.values(remoteEditedMap||{}).sort((a,b)=> (a.id||0)-(b.id||0));
  if (!entries.length){
    list.classList.add("empty");
    list.textContent = "Göstəriləcək dəyişiklik yoxdur";
    return;
  }
  list.classList.remove("empty");
  entries.forEach(e=>{
    const btn = document.createElement("button");
    btn.className = "mini-pill";
    btn.textContent = "#" + e.id;
    const newQ = e && e.after && e.after.question ? String(e.after.question) : "";
    if (newQ) btn.title = newQ.slice(0,96);
    btn.addEventListener("click", ()=>{
      editedQuestions[e.id] = Object.assign({}, e, { active: "after" });
      applyEditedQuestions();
      saveCategoryState();
      renderAll();
    });
    list.appendChild(btn);
  });
}

async function refreshCloudEditedPreview(){
  const list = document.getElementById("cloudEditedQuestionsList");
  const status = document.getElementById("cloudStatus");
  if (status) status.textContent = "Bulud · yüklənir…";
  if (list) { list.classList.remove("empty"); list.innerHTML = ""; }
  try{
    if (!FB.user || !FB.db){
      if (list){ list.classList.add("empty"); list.textContent = "Giriş tələb olunur"; }
      if (status) status.textContent = "Bulud · —";
      return;
    }
    const remote = await fetchRemoteStateRaw(); // { data, updatedAt }
    const map = _getRemoteEditedForCurrentCategory(remote);
    renderCloudEditedList(map, remote && remote.updatedAt);
  }catch(e){
    if (list){ list.classList.add("empty"); list.textContent = "Yükləmə xətası"; }
    if (status) status.textContent = "Bulud · —";
  }
}
(function(){
  const btn = document.getElementById("cloudRefreshBtn");
  if (btn && !btn.__wired){
    btn.__wired = true;
    btn.addEventListener("click", ()=> refreshCloudEditedPreview());
  }
  setTimeout(()=> refreshCloudEditedPreview(), 0);
})();
// /mnt/data/app.js
/* ====== PUBLIC (readable-by-everyone) EDITED QUESTIONS ====== */
/* Firestore: publicAppState/state -> { data: { "<quiz_<cat>_editedQuestions>": { ... } }, updatedAt } */

// Public doc ref (no auth required to read if rules allow)
function getPublicEditedDocRef(){
  try{
    if (!firebaseAvailable()) return null;
    if (!FB.app) FB.app = firebase.initializeApp(window.FIREBASE_CONFIG);
    if (!FB.db)  FB.db  = firebase.firestore();
    return FB.db.collection("publicAppState").doc("state");
  }catch{ return null; }
}

// Read whole public payload (safe for anonymous)
async function fetchPublicEditedRaw(){
  const ref = getPublicEditedDocRef(); if (!ref) return { data:{}, updatedAt:null };
  const snap = await ref.get();
  if (!snap.exists) return { data:{}, updatedAt:null };
  const d = snap.data() || {};
  return { data: (d.data||{}), updatedAt: d.updatedAt || null };
}

// Write ONLY current category's editedQuestions to public (merge)
async function savePublicEditedForCurrentCategory(){
  try{
    const ref = getPublicEditedDocRef(); if (!ref) return;
    const key = storageKey("editedQuestions");
    const payload = { data: {} };
    payload.data[key] = editedQuestions || {};
    await ref.set({ 
      data: payload.data, 
      updatedAt: firebase.firestore.FieldValue.serverTimestamp() 
    }, { merge: true });
  }catch(e){
    // WHY: public yazı qaydaları deploymentdə idarə olunur; uğursuz olsa app dayanmasın
    console.warn("Public save failed:", e && e.message ? e.message : e);
  }
}

/* ====== UI WIRING: Cloud list should read from PUBLIC, no login needed ====== */
// REPLACE: refreshCloudEditedPreview -> public read (no FB.user check)
async function refreshCloudEditedPreview(){
  const list = document.getElementById("cloudEditedQuestionsList");
  const status = document.getElementById("cloudStatus");
  if (status) status.textContent = "Bulud · yüklənir…";
  if (list) { list.classList.remove("empty"); list.innerHTML = ""; }
  try{
    if (!firebaseAvailable()){
      if (list){ list.classList.add("empty"); list.textContent = "Firebase konfiqurasiya olunmayıb"; }
      if (status) status.textContent = "Bulud · —";
      return;
    }
    const remote = await fetchPublicEditedRaw(); // << public doc
    // Only this category's map
    const key = storageKey("editedQuestions");
    const raw = (remote && remote.data) ? remote.data[key] : {};
    const map = (typeof raw === "string") ? _parseJSONMaybe(raw) : (raw || {});
    renderCloudEditedList(map, remote && remote.updatedAt);
  }catch(e){
    if (list){ list.classList.add("empty"); list.textContent = "Yükləmə xətası"; }
    if (status) status.textContent = "Bulud · —";
  }
}

/* ====== HOOK INTO ADMIN SAVE: also push to PUBLIC ====== */
// Patch: call savePublicEditedForCurrentCategory() after local save
(function patchEditQuestionPublicSave(){
  // keep original reference
  const _origEditQuestion = window.editQuestion;
  if (typeof _origEditQuestion !== "function") return;

  window.editQuestion = function(id){
    // wrap to inject onSave handler patch
    const beforeRenderAll = renderAll; // keep pointer

    // Monkey-patch buildInlineEditor -> onSave
    const _origBuild = window.buildInlineEditor;
    if (typeof _origBuild === "function"){
      window.buildInlineEditor = function(q, handlers){
        const h = Object.assign({}, handlers);
        const userOnSave = h.onSave;
        h.onSave = (payload)=>{
          // run original onSave first (writes editedQuestions locally)
          if (typeof userOnSave === "function") userOnSave(payload);
          // then push to PUBLIC (async, fire-and-forget)
          try{ savePublicEditedForCurrentCategory(); }catch{}
          // nothing else changes
        };
        const form = _origBuild(q, h);
        // restore to avoid double-wrapping other calls
        window.buildInlineEditor = _origBuild;
        return form;
      };
    }
    // call original flow
    return _origEditQuestion(id);
  };
})();

/* ====== WIRING FOR REFRESH BUTTON (idempotent) ====== */
(function(){
  const btn = document.getElementById("cloudRefreshBtn");
  if (btn && !btn.__wired){
    btn.__wired = true;
    btn.addEventListener("click", ()=> refreshCloudEditedPreview());
  }
  // Auto-load once
  setTimeout(()=> refreshCloudEditedPreview(), 0);
})();

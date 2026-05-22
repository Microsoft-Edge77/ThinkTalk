/* ============================================================
   IMPORTS FIREBASE
============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore, collection, addDoc, onSnapshot, query, orderBy, where,
  serverTimestamp, getDocs, deleteDoc, doc, getDoc, setDoc, limit
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* ============================================================
   FIREBASE INIT
============================================================ */

const cfg = {
  apiKey: "AIzaSyCv4nD9Nyez5ERGvW47q-6O-TA96zWJn0M",
  authDomain: "thinktalk-b3c85.firebaseapp.com",
  projectId: "thinktalk-b3c85",
  storageBucket: "thinktalk-b3c85.firebasestorage.app",
  messagingSenderId: "752141817301",
  appId: "1:752141817301:web:28fecaf81db27eb51d595c"
};

const app = initializeApp(cfg);
const db = getFirestore(app);

/* ============================================================
   SHORTCUTS
============================================================ */

const byId = (id) => document.getElementById(id);
const qsa = (sel) => Array.from(document.querySelectorAll(sel));
const debounce = (fn, wait=200) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; };
const getAccent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();

/* ============================================================
   GLOBAL STATE
============================================================ */

let currentUser = localStorage.getItem("tt_user") || null;
let curRoom = "général";
let unsubChat = null;
let selectedMsgId = null;
let authMode = "login";
let confirmCallback = null;
let isPrivateCurrent = false;

let roomsCache = [];
let contactsCache = [];
const lastMessagesByRoom = new Map();
const lastMessagesByDM = new Map();

let allowedRooms = [];
try { allowedRooms = JSON.parse(localStorage.getItem("tt_allowedRooms") || "[]"); } catch { allowedRooms = []; }

/* ============================================================
   PARTICLES
============================================================ */

(function initParticles(){
  const canvas = byId("canvas-dust");
  const ctx = canvas.getContext("2d");
  let pts = [];
  const mouse = { x:-10000, y:-10000 };

  function resizeCanvas(){ canvas.width = innerWidth; canvas.height = innerHeight; }
  addEventListener("resize", resizeCanvas);
  resizeCanvas();

  addEventListener("mousemove", (e)=>{ mouse.x=e.clientX; mouse.y=e.clientY; });

  class Particle {
    constructor(){ this.init(); this.target=null; }
    init(){
      this.x=Math.random()*canvas.width;
      this.y=Math.random()*canvas.height;
      this.vx=(Math.random()-0.5)*1.2;
      this.vy=(Math.random()-0.5)*1.2;
      this.s=Math.random()*2+1;
    }
    update(){
      if(this.target){
        this.x+=(this.target.x-this.x)*0.15;
        this.y+=(this.target.y-this.y)*0.15;
        return;
      }
      const dx=mouse.x-this.x, dy=mouse.y-this.y, d=Math.hypot(dx,dy);
      if(d<100){
        this.vx-=dx*0.0003;
        this.vy-=dy*0.0003;
      }
      this.x+=this.vx;
      this.y+=this.vy;
      this.vx*=0.99;
      this.vy*=0.99;
      if(this.x<0||this.x>canvas.width) this.vx*=-1;
      if(this.y<0||this.y>canvas.height) this.vy*=-1;
    }
    draw(){
      const accent = getAccent() || "#0078d7";
      const hex = accent.startsWith("#") ? accent : "#0078d7";
      ctx.fillStyle = hex.length===7 ? hex+"cc" : hex;
      ctx.shadowBlur=8;
      ctx.shadowColor=hex;
      ctx.beginPath();
      ctx.arc(this.x,this.y,this.s,0,Math.PI*2);
      ctx.fill();
      ctx.shadowBlur=0;
    }
  }

  for(let i=0;i<380;i++) pts.push(new Particle());

  (function anim(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    pts.forEach(p=>{p.update();p.draw();});
    requestAnimationFrame(anim);
  })();

  window.materialize = (el, delay=0) => {
    setTimeout(()=>{
      const r = el.getBoundingClientRect();
      const pCount = 30;
      const targets = [];
      for(let i=0;i<pCount;i++){
        targets.push({x:r.left+(r.width/pCount)*i,y:r.top});
        targets.push({x:r.left+(r.width/pCount)*i,y:r.bottom});
      }
      pts.forEach((p,i)=>{ if(targets[i]) p.target = targets[i]; });
      setTimeout(()=>{ pts.forEach(p=>p.target=null); el.classList.add("visible"); }, 700);
    }, delay);
  };

})();

/* ============================================================
   POPUPS
============================================================ */

function openPopup(popId, cardId){
  const pop = byId(popId), card = byId(cardId);
  if(!pop||!card) return;
  pop.style.display = "flex";
  materialize(card);
}

function closePopups(){
  qsa(".popup-overlay").forEach(p=>p.style.display="none");
  qsa(".popup-card").forEach(c=>c.classList.remove("visible"));
}

function showMessage(text, title="INFO"){
  byId("msg-title").innerText = title;
  byId("msg-text").innerText = text;
  openPopup("pop-message","card-message");
}

function showConfirm(text, onYes, title="CONFIRMATION"){
  confirmCallback = onYes;
  byId("confirm-title").innerText = title;
  byId("confirm-text").innerText = text;
  openPopup("pop-confirm","card-confirm");
}

/* ============================================================
   AUTH
============================================================ */

function updateAuthUI(){
  const title = byId("auth-mode-title"), btn = byId("btn-login"), toggle = byId("auth-toggle");
  const card = byId("auth-card");
  card.classList.add("auth-switching");

  if(authMode==="login"){
    title.innerText="Se connecter";
    btn.innerText="SE CONNECTER";
    toggle.innerText="Vous n'avez pas de compte ? Rejoindre ThinkTalk";
  } else {
    title.innerText="Créer un compte";
    btn.innerText="CRÉER UN COMPTE";
    toggle.innerText="Vous avez déjà un compte ? Se connecter";
  }

  setTimeout(()=>{
    card.classList.remove("auth-switching");
    card.classList.add("auth-active");
  }, 200);
}

async function handleLogin(){
  const p = byId("auth-pseudo").value.trim().toLowerCase();
  const c = byId("auth-code").value.trim();
  if(!p||!c){ showMessage("Pseudo et code requis."); return; }

  try {
    const uRef = doc(db,"users",p);
    const uDoc = await getDoc(uRef);

    if(authMode==="login"){
      if(uDoc.exists()){
        if(uDoc.data().code === c){
          localStorage.setItem("tt_user", p);
          currentUser = p;
          byId("auth-screen").style.display = "none";
          byId("main-app").style.display = "flex";
          enterRoom("général");
        } else showMessage("Code secret incorrect.");
      } else showMessage("Ce compte n'existe pas.");
    } else {
      if(uDoc.exists()){ showMessage("Ce pseudo est déjà utilisé."); return; }
      await setDoc(uRef, { code: c });
      localStorage.setItem("tt_user", p);
      currentUser = p;
      byId("auth-screen").style.display = "none";
      byId("main-app").style.display = "flex";
      enterRoom("général");
    }
  } catch(e){
    console.error(e);
    showMessage("Erreur de connexion.");
  }
}

/* ============================================================
   BACKGROUND CHAT
============================================================ */

async function loadChatBackground(roomName, isPrivateChat){
  const view = byId("view-chat");
  if(!view) return;

  try {
    if(isPrivateChat){
      const dmKey = curRoom;
      const bgRef = doc(db,"dmBackgrounds", dmKey);
      const bgDoc = await getDoc(bgRef);
      if(bgDoc.exists() && bgDoc.data().background){
        view.style.backgroundImage = `url(${bgDoc.data().background})`;
      } else {
        view.style.backgroundImage = "none";
      }
    } else {
      const r = roomsCache.find(r=>r.name===roomName);
      if(r && r.background){
        view.style.backgroundImage = `url(${r.background})`;
      } else {
        view.style.backgroundImage = "none";
      }
    }
  } catch(e){
    console.error(e);
    view.style.backgroundImage = "none";
  }
}

function compressImageToBase64(file, maxW=900, maxH=700, quality=0.1){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = e=>{
      const img = new Image();
      img.onload = ()=>{
        let w = img.width;
        let h = img.height;
        const ratio = Math.min(maxW/w, maxH/h, 1);
        w = Math.round(w*ratio);
        h = Math.round(h*ratio);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const cctx = c.getContext("2d");
        cctx.drawImage(img,0,0,w,h);
        const data = c.toDataURL("image/jpeg", quality);
        resolve(data);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function setBackgroundForCurrentChat(file){
  if(!file || !currentUser) return;

  try {
    const dataUrl = await compressImageToBase64(file);

    if(isPrivateCurrent){
      const dmKey = curRoom;
      await setDoc(doc(db,"dmBackgrounds", dmKey), { background: dataUrl });
    } else {
      const r = roomsCache.find(r=>r.name===curRoom);

      if(!r){
        showMessage("Le salon n'est pas encore chargé. Réessaie dans 1 seconde.");
        return;
      }

      await setDoc(doc(db,"rooms", r._id), { ...r, background: dataUrl });
    }

    await loadChatBackground(
      isPrivateCurrent ? curRoom.split("_").find(n=>n!==currentUser) : curRoom,
      isPrivateCurrent
    );

  } catch(e){
    console.error(e);
    showMessage("Erreur lors de la mise à jour du fond d'écran.");
  }
}
/* ============================================================
   ENTER ROOM (PRIVÉ + PUBLIC)
============================================================ */

async function enterRoom(name, isPrivateChat=false){
  if(!currentUser){ showMessage("Connecte-toi d'abord."); return; }

  if(!isPrivateChat){
    const rSnap = await getDocs(query(collection(db,"rooms"), where("name","==",name), limit(1)));
    if(!rSnap.empty){
      const roomDoc = rSnap.docs[0];
      const roomData = roomDoc.data();
      const pass = roomData.pass || "";
      const owner = roomData.owner || null;

      if(pass && pass !== ""){
        const roomKey = name;
        const alreadyAllowed = allowedRooms.includes(roomKey);
        const isOwner = owner === currentUser;

        if(!alreadyAllowed && !isOwner){
          const inputId = "room-pass-input";
          byId("msg-title").innerText = "Salon privé";
          byId("msg-text").innerHTML = "Ce salon est privé. Entrez le code :<br><br>" +
            `<input id="${inputId}" type="password" class="input-box" placeholder="Code du salon">`;
          openPopup("pop-message","card-message");

          const okBtn = byId("msg-ok-btn");
          const old = okBtn.onclick;

          okBtn.onclick = async () => {
            const val = byId(inputId).value.trim();
            closePopups();
            okBtn.onclick = old || null;

            if(val !== pass){ showMessage("Code erroné."); return; }

            allowedRooms.push(roomKey);
            localStorage.setItem("tt_allowedRooms", JSON.stringify(allowedRooms));
            proceedEnter();
          };
          return;
        }
      }
    }
  }

  proceedEnter();

  function proceedEnter(){
    curRoom = isPrivateChat ? [currentUser,name].sort().join("_") : name;
    isPrivateCurrent = isPrivateChat;

    byId("chat-header").innerText = (isPrivateChat ? "@ " : "# ") + name;
    switchTab("chat");

    if(unsubChat) unsubChat();

    const qMsg = query(collection(db,"messages"), where("room","==",curRoom), orderBy("timestamp","asc"));
    unsubChat = onSnapshot(qMsg, (snap) => {
      const box = byId("chat-messages");
      box.innerHTML = "";

      snap.forEach((d) => {
        const m = d.data();
        const date = m.timestamp?.seconds ? new Date(m.timestamp.seconds*1000) : new Date();
        const hh = String(date.getHours()).padStart(2,"0");
        const mm = String(date.getMinutes()).padStart(2,"0");
        const timeStr = `${hh}:${mm}`;

        const div = document.createElement("div");
        div.className = "msg-block" + (m.sender === currentUser ? " own" : "");

        const info = document.createElement("div");
        info.className = "msg-info";
        info.innerHTML = `<span>${m.sender}</span><span>${timeStr}</span>`;

        const content = document.createElement("div");
        content.className = "msg-text";

        if(m.image){
          const img = document.createElement("img");
          img.src = m.image;
          img.className = "msg-img";
          content.appendChild(img);
        } else {
          content.textContent = m.text || "";
        }

        div.appendChild(info);
        div.appendChild(content);

        if(m.sender === currentUser){
          div.onclick = () => { selectedMsgId = d.id; openPopup("pop-options","card-options"); };
        }

        box.appendChild(div);
        setTimeout(()=>div.classList.add("visible"), 20);
      });

      box.parentElement.scrollTop = box.parentElement.scrollHeight;
    });

    loadChatBackground(name, isPrivateChat);
  }
}

/* ============================================================
   CREATE ROOM
============================================================ */

async function createRoom(){
  const name = byId("new-room-name").value.trim();
  const pass = byId("new-room-pass").value.trim();
  if(!name) return;
  if(!currentUser){ showMessage("Connecte-toi d'abord."); return; }

  try {
    const rSnap = await getDocs(query(collection(db,"rooms"), where("name","==",name), limit(1)));
    if(!rSnap.empty){ showMessage("Un salon avec ce nom existe déjà."); return; }

    await addDoc(collection(db,"rooms"), { name, pass, owner: currentUser });

    closePopups();
    byId("new-room-name").value = "";
    byId("new-room-pass").value = "";

  } catch(e){
    console.error(e);
    showMessage("Erreur lors de la création du salon.");
  }
}

/* ============================================================
   SEND MESSAGE / IMAGE
============================================================ */

async function sendMessage(){
  if(!currentUser){ showMessage("Connecte-toi d'abord."); return; }
  const i = byId("chat-input");
  const text = i.value.trim();
  if(!text) return;

  try {
    await addDoc(collection(db,"messages"), {
      text,
      room: curRoom,
      sender: currentUser,
      timestamp: serverTimestamp()
    });
    i.value = "";
  } catch(e){
    console.error(e);
    showMessage("Erreur lors de l'envoi du message.");
  }
}

function sendImage(file){
  if(!file || !currentUser) return;

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      await addDoc(collection(db,"messages"), {
        image: ev.target.result,
        room: curRoom,
        sender: currentUser,
        timestamp: serverTimestamp()
      });
    } catch(err){
      console.error(err);
      showMessage("Erreur lors de l'envoi de l'image.");
    }
  };
  reader.readAsDataURL(file);
}

/* ============================================================
   DELETE MESSAGE
============================================================ */

async function deleteMessage(){
  if(!selectedMsgId) return;

  try {
    await deleteDoc(doc(db,"messages",selectedMsgId));
  } catch(e){
    console.error(e);
    showMessage("Impossible de supprimer le message.");
  }

  closePopups();
  selectedMsgId = null;
}

/* ============================================================
   CONTACTS + SUGGESTIONS
============================================================ */

async function suggestUsers(prefix){
  if(prefix.length < 1) return [];

  const snap = await getDocs(collection(db,"users"));
  const all = snap.docs.map(d=>d.id);
  return all.filter(u => u.startsWith(prefix.toLowerCase()));
}

function renderSuggestions(list){
  const box = byId("contact-suggestions");
  box.innerHTML = "";

  list.forEach(name=>{
    const div = document.createElement("div");
    div.className = "suggest-item";
    div.textContent = name;
    div.onclick = () => {
      byId("contact-name-input").value = name;
      box.innerHTML = "";
    };
    box.appendChild(div);
  });
}

async function addContact(){
  if(!currentUser){ showMessage("Connecte-toi d'abord."); return; }
  const name = byId("contact-name-input").value.trim().toLowerCase();
  if(!name || name === currentUser) return;

  try {
    const uRef = doc(db,"users",name);
    const uDoc = await getDoc(uRef);

    if(!uDoc.exists()){
      showMessage("Ce contact n'existe pas sur ThinkTalk.");
      return;
    }

    const existing = contactsCache.find(c => c.owner===currentUser && c.name===name);
    if(existing){
      showMessage("Contact déjà ajouté.");
      byId("contact-name-input").value="";
      return;
    }

    await addDoc(collection(db,"contacts"), { owner: currentUser, name });
    byId("contact-name-input").value = "";

  } catch(e){
    console.error(e);
    showMessage("Erreur lors de l'ajout du contact.");
  }
}

/* ============================================================
   SNAPSHOTS (MESSAGES / ROOMS / CONTACTS)
============================================================ */

function normalize(str){
  return (str||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
}

function setupMessagesSnapshot(){
  const qAll = query(collection(db,"messages"), orderBy("timestamp","asc"));

  onSnapshot(qAll, (snap) => {
    lastMessagesByRoom.clear();
    lastMessagesByDM.clear();

    snap.forEach((d) => {
      const m = d.data();
      const room = m.room;
      if(!room) return;

      const entry = { sender: m.sender, text: m.text || (m.image ? "[image]" : "") };

      if(room.includes("_") && !room.includes(" ")){
        const arr = lastMessagesByDM.get(room) || [];
        arr.push(entry);
        if(arr.length>2) arr.shift();
        lastMessagesByDM.set(room, arr);
      } else {
        const arr = lastMessagesByRoom.get(room) || [];
        arr.push(entry);
        if(arr.length>2) arr.shift();
        lastMessagesByRoom.set(room, arr);
      }
    });

    renderRoomsTiles();
    renderContactsTiles();
  });
}
/* ============================================================
   ROOMS & CONTACTS TILES
============================================================ */

function renderRoomsTiles(){
  const g = byId("rooms-grid");
  if(!g) return;

  g.innerHTML = "";
  const search = normalize(byId("rooms-search").value.trim());

  roomsCache.forEach((r) => {
    if(!r.name) return;

    // Masquer les salons privés si pas de recherche
    if(r.pass && !search) return;

    const previews = lastMessagesByRoom.get(r.name) || [];
    const previewText = previews.map(m=>`${m.sender}: ${m.text}`).join(" • ").slice(0,120);

    const haystack = normalize(r.name) + " " + normalize(previewText);
    if(search && !haystack.includes(search)) return;

    const t = document.createElement("div");
    t.className = "tile";
    t.innerHTML = `
      <div class="title">
        <span># ${r.name}</span>
        ${r.pass ? '<span class="lock-badge">🔒</span>' : ''}
      </div>
      <div class="tile-preview">${previewText || '<span class="muted">Aucun message</span>'}</div>
    `;

    if(r.owner === currentUser){
      const delBtn = document.createElement("button");
      delBtn.className = "tile-delete-btn";
      delBtn.textContent = "Suppr.";
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        showConfirm(`Supprimer le salon #${r.name} ?`, async () => {
          try { await deleteDoc(doc(db,"rooms", r._id)); }
          catch(e){ console.error(e); showMessage("Erreur lors de la suppression du salon."); }
        });
      };
      t.appendChild(delBtn);
    }

    t.onclick = () => enterRoom(r.name);
    g.appendChild(t);
  });
}

function renderContactsTiles(){
  const g = byId("contacts-grid");
  if(!g || !currentUser) return;

  g.innerHTML = "";
  const search = normalize(byId("contacts-search").value.trim());

  const list = new Set();
  contactsCache.forEach((c) => {
    if(!c.owner || !c.name) return;
    if(c.owner === currentUser) list.add(c.name);
    if(c.name === currentUser) list.add(c.owner);
  });

  Array.from(list).forEach((name) => {
    const dmKey = [currentUser, name].sort().join("_");
    const previews = lastMessagesByDM.get(dmKey) || [];
    const previewText = previews.map(m=>`${m.sender}: ${m.text}`).join(" • ").slice(0,120);

    const haystack = normalize(name) + " " + normalize(previewText);
    if(search && !haystack.includes(search)) return;

    const t = document.createElement("div");
    t.className = "tile";
    t.innerHTML = `
      <div class="title"><span>@ ${name}</span></div>
      <div class="tile-preview">${previewText || '<span class="muted">Aucun message</span>'}</div>
    `;

    const contactObj = contactsCache.find(c => c.owner===currentUser && c.name===name);

    if(contactObj){
      const delBtn = document.createElement("button");
      delBtn.className = "tile-delete-btn";
      delBtn.textContent = "Suppr.";
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        showConfirm(`Supprimer le contact @${name} ?`, async () => {
          try { await deleteDoc(doc(db,"contacts", contactObj._id)); }
          catch(e){ console.error(e); showMessage("Erreur lors de la suppression du contact."); }
        });
      };
      t.appendChild(delBtn);
    }

    t.onclick = () => enterRoom(name, true);
    g.appendChild(t);
  });
}

/* ============================================================
   SNAPSHOTS ROOMS + CONTACTS
============================================================ */

function setupRoomsSnapshot(){
  onSnapshot(collection(db,"rooms"), (snap) => {
    roomsCache = [];
    snap.forEach((d) => {
      const r = d.data();
      roomsCache.push({ ...r, _id: d.id });
    });
    renderRoomsTiles();
  });
}

function setupContactsSnapshot(){
  onSnapshot(collection(db,"contacts"), (snap) => {
    contactsCache = [];
    snap.forEach((d) => {
      const c = d.data();

      if(c && c.name === currentUser && c.owner && c.owner !== currentUser){
        const newData = { owner: c.name, name: c.owner };
        setDoc(doc(db,"contacts", d.id), newData);
        contactsCache.push({ ...newData, _id: d.id });
      } else {
        contactsCache.push({ ...c, _id: d.id });
      }
    });

    renderContactsTiles();
  });
}

/* ============================================================
   ACCENT + NÉONS (CORRIGÉ)
============================================================ */

let neonInterval = null;
let neonCycle = [];
let neonIndex = 0;

function startNeonCycle(){
  if(neonInterval) clearInterval(neonInterval);

  neonInterval = setInterval(()=>{
    neonIndex = (neonIndex+1) % neonCycle.length;
    applyAccent(neonCycle[neonIndex]);
  }, 250);
}

function stopNeonCycle(){
  if(neonInterval) clearInterval(neonInterval);
  neonInterval = null;
}

function applyAccent(color){
  document.documentElement.style.setProperty("--accent", color);
  localStorage.setItem("tt_accent", color);
}

function initAccent(){
  const saved = localStorage.getItem("tt_accent");
  if(saved) applyAccent(saved);

  const presets = ["#0078d7","#8e44ad","#27ae60","#e67e22","#e91e63","#ff4757","#1abc9c","#f1c40f","#3498db","#9b59b6"];
  const grid = byId("accent-presets");
  grid.innerHTML = "";

  presets.forEach((c) => {
    const dot = document.createElement("div");
    dot.className = "color-dot";
    dot.style.background = c;

    dot.onclick = () => {
      stopNeonCycle();
      qsa(".color-dot").forEach(d=>d.classList.remove("selected"));
      dot.classList.add("selected");
      applyAccent(c);
    };

    grid.appendChild(dot);
  });

  byId("btn-more-colors").onclick = () => {
    byId("advanced-color").classList.toggle("hidden");
  };

  const picker = byId("accent-picker");
  picker.value = saved || "#0078d7";
  picker.oninput = () => { stopNeonCycle(); applyAccent(picker.value); };

  const neonDefs = [
    { cycle:["#ff0033","#ff8800","#ffcc00"] },
    { cycle:["#00eaff","#33f1ff","#0099ff"] },
    { cycle:["#39ff14","#b3ff00","#ccff33"] },
    { cycle:["#b300ff","#ff00ff","#ff66ff"] }
  ];

  byId("btn-neon-colors").onclick = () => {
    grid.innerHTML = "";

    neonDefs.forEach((n)=>{
      const dot = document.createElement("div");
      dot.className = "color-dot";
      dot.style.background = `radial-gradient(circle at 30% 30%, ${n.cycle[0]}, ${n.cycle[1]})`;

      dot.onclick = () => {
        stopNeonCycle();
        neonCycle = n.cycle;
        neonIndex = 0;
        startNeonCycle();
      };

      grid.appendChild(dot);
    });
  };
}

/* ============================================================
   UI + INIT
============================================================ */

async function ensureGeneralRoom(){
  try {
    const rSnap = await getDocs(query(collection(db,"rooms"), where("name","==","général"), limit(1)));
    if(rSnap.empty){
      await addDoc(collection(db,"rooms"), { name: "général", pass: "", owner: "system" });
    }
  } catch(e){
    console.error("ensureGeneralRoom error", e);
  }
}

function initUI(){
  qsa(".nav-btn").forEach((btn)=> btn.addEventListener("click", ()=> switchTab(btn.dataset.tab)));

  byId("btn-open-session").addEventListener("click", ()=> openPopup("pop-logout","card-logout"));
  byId("btn-open-create").addEventListener("click", ()=> openPopup("pop-create","card-create"));
  byId("btn-open-accent").addEventListener("click", ()=> openPopup("pop-accent","card-accent"));

  qsa("[data-close-popup]").forEach((b)=> b.addEventListener("click", closePopups));

  byId("btn-logout").addEventListener("click", ()=> {
    localStorage.removeItem("tt_user");
    location.reload();
  });

  byId("btn-delete-profile").addEventListener("click", async ()=> {
    if(!currentUser) return;

    showConfirm("Supprimer définitivement le profil et les contacts liés ?", async ()=> {
      try {
        await deleteDoc(doc(db,"users", currentUser));

        const contactsRef = collection(db,"contacts");
        const q1 = query(contactsRef, where("owner","==", currentUser));
        const q2 = query(contactsRef, where("name","==", currentUser));

        const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)]);
        snap1.forEach(d => deleteDoc(doc(db,"contacts", d.id)));
        snap2.forEach(d => deleteDoc(doc(db,"contacts", d.id)));

        localStorage.removeItem("tt_user");
        showMessage("Profil supprimé.");
        setTimeout(()=> location.reload(), 800);

      } catch(e){
        console.error(e);
        showMessage("Erreur lors de la suppression du profil.");
      }
    });
  });

  byId("msg-ok-btn").addEventListener("click", closePopups);
  byId("confirm-yes").addEventListener("click", ()=> { if(confirmCallback) confirmCallback(); confirmCallback=null; closePopups(); });
  byId("confirm-no").addEventListener("click", ()=> { confirmCallback=null; closePopups(); });

  byId("btn-login").addEventListener("click", handleLogin);
  byId("auth-code").addEventListener("keydown", (e)=> { if(e.key==="Enter") handleLogin(); });
  byId("auth-toggle").addEventListener("click", ()=> { authMode = authMode==="login" ? "register" : "login"; updateAuthUI(); });

  byId("btn-do-create").addEventListener("click", createRoom);
  byId("rooms-search").addEventListener("input", debounce(()=> renderRoomsTiles(), 180));

  byId("send-btn").addEventListener("click", sendMessage);
  byId("chat-input").addEventListener("keydown", (e)=> { if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendMessage(); } });

  byId("btn-attach").addEventListener("click", ()=> byId("file-input").click());
  byId("file-input").addEventListener("change", (e)=> {
    const file = e.target.files[0];
    if(file) sendImage(file);
    e.target.value="";
  });

  byId("btn-msg-del").addEventListener("click", deleteMessage);

  byId("btn-wallpaper").addEventListener("click", ()=> byId("bg-file-input").click());
  byId("bg-file-input").addEventListener("change", async (e)=> {
    const file = e.target.files[0];
    if(file) await setBackgroundForCurrentChat(file);
    e.target.value="";
  });

  byId("btn-add-contact").addEventListener("click", addContact);

  byId("contact-name-input").addEventListener("input", debounce(async (e)=>{
    const val = e.target.value.trim().toLowerCase();
    const suggestions = await suggestUsers(val);
    renderSuggestions(suggestions);
  }, 200));

  byId("contacts-search").addEventListener("input", debounce(()=> renderContactsTiles(), 180));

  initAccent();
  updateAuthUI();
}

async function initApp(){
  initUI();
  await ensureGeneralRoom();

  setupRoomsSnapshot();
  setupContactsSnapshot();
  setupMessagesSnapshot();

  if(currentUser){
    byId("auth-screen").style.display = "none";
    byId("main-app").style.display = "flex";
    enterRoom("général");
  } else {
    byId("auth-screen").style.display = "flex";
    byId("main-app").style.display = "none";
  }
}

initApp();

/* ============================================================
   SWITCH TAB
============================================================ */

function switchTab(tab){
  const appRoot = byId("main-app");
  appRoot.classList.add("view-blur");

  qsa(".nav-btn").forEach(b=>b.classList.remove("active"));
  const btn = qsa(".nav-btn").find(b=>b.dataset.tab===tab);
  if(btn) btn.classList.add("active");

  setTimeout(()=> {
    qsa(".view-section").forEach(s=>s.classList.remove("active"));
    const view = byId("view-"+tab);
    if(view) view.classList.add("active");

    // Wallpaper uniquement dans CHAT
    byId("btn-wallpaper").style.display = (tab === "chat") ? "block" : "none";

    appRoot.classList.remove("view-blur");

    if(tab==="chat"){
      qsa(".msg-block").forEach((m,i)=>{ m.classList.remove("visible"); materialize(m, i*60); });
    }
  }, 300);
}

addEventListener("beforeunload", ()=> { if(unsubChat) unsubChat(); });

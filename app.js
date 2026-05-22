/* ============================================================
   IMPORTS FIREBASE
============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore, collection, addDoc, onSnapshot, query, orderBy, where,
  serverTimestamp, getDocs, deleteDoc, doc, getDoc, setDoc, limit, updateDoc
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
   PARTICLES (ENCAPSULÉES)
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
   BACKGROUND CHAT (CORRIGÉ)
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
   ENTER ROOM (CORRIGÉ PRIVÉ + MASQUAGE)
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
   CONTACTS + SUGGESTIONS (NOUVEAU)
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
    div.onclick = () =>

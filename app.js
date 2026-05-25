/* ============================================================
   FIREBASE IMPORTS
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
   UTILITAIRES
============================================================ */

const byId = id => document.getElementById(id);
const qsa = sel => Array.from(document.querySelectorAll(sel));

const utf8ToBytes = str => new TextEncoder().encode(str);
const bytesToUtf8 = bytes => new TextDecoder().decode(bytes);

const base64FromBytes = bytes => {
  let bin = "";
  for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

const bytesFromBase64 = b64 => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return arr;
};

const randHex = (len=16) => {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b=>b.toString(16).padStart(2,"0")).join("");
};

/* ============================================================
   ETAT GLOBAL
============================================================ */

let currentUser = localStorage.getItem("tt_user") || null;
let curRoom = "général";
let isPrivateCurrent = false;
let unsubChat = null;

/* ============================================================
   OTP DM (One-Time Pad simplifié)
============================================================ */

async function deriveKeystream(secret, room, salt, length){
  const seedStr = `${secret}|${room}|${salt}`;
  let seed = utf8ToBytes(seedStr);
  let out = new Uint8Array(0);
  let counter = 0;

  while(out.length < length){
    const ctr = new Uint8Array([counter&255,(counter>>8)&255,(counter>>16)&255,(counter>>24)&255]);
    const data = new Uint8Array(seed.length + ctr.length);
    data.set(seed,0); data.set(ctr, seed.length);

    const hashBuf = await crypto.subtle.digest("SHA-256", data);
    const hash = new Uint8Array(hashBuf);

    const newOut = new Uint8Array(out.length + hash.length);
    newOut.set(out,0); newOut.set(hash,out.length);
    out = newOut;

    counter++;
    if(counter > 1024) throw "deriveKeystream overflow";
  }
  return out.slice(0,length);
}

function xorBytes(a,b){
  const n = Math.min(a.length,b.length);
  const out = new Uint8Array(n);
  for(let i=0;i<n;i++) out[i] = a[i] ^ b[i];
  return out;
}

async function encryptOTP(plaintext, secret, room){
  const salt = randHex(12);
  const pt = utf8ToBytes(plaintext);
  const ks = await deriveKeystream(secret, room, salt, pt.length);
  const cipher = xorBytes(pt, ks);
  return { cipher: base64FromBytes(cipher), salt };
}

async function decryptOTP(cipherB64, secret, room, salt){
  const cipher = bytesFromBase64(cipherB64);
  const ks = await deriveKeystream(secret, room, salt, cipher.length);
  const pt = xorBytes(cipher, ks);
  return bytesToUtf8(pt);
}

/* ============================================================
   GESTION DES CLES DM
============================================================ */

function dmKeyStorageKey(dmKey){ return "tt_dmkey_" + dmKey; }

function setDMKey(dmKey, secret){
  localStorage.setItem(dmKeyStorageKey(dmKey), secret);
}

function getDMKey(dmKey){
  return localStorage.getItem(dmKeyStorageKey(dmKey));
}

function promptDMKey(dmKey, displayName){
  const secret = prompt(`Clé secrète pour discuter avec ${displayName} :`);
  if(secret && secret.trim().length > 0){
    setDMKey(dmKey, secret.trim());
    return secret.trim();
  }
  return null;
}

/* ============================================================
   COMPRESSION IMAGE (pour DM + wallpapers)
============================================================ */

function compressImageToBase64(src, maxW=900, maxH=700, quality=0.08){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    img.onload = ()=>{
      let w = img.width, h = img.height;
      const ratio = Math.min(maxW/w, maxH/h, 1);
      w = Math.round(w*ratio);
      h = Math.round(h*ratio);

      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img,0,0,w,h);

      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    img.src = typeof src === "string" ? src : URL.createObjectURL(src);
  });
}

/* ============================================================
   ENVOI MESSAGE (DM chiffré + public)
============================================================ */

async function sendMessageEncrypted(text){
  if(!currentUser) return;
  if(!text || !text.trim()) return;

  try {
    if(isPrivateCurrent){
      const dmKey = curRoom;
      let secret = getDMKey(dmKey);
      if(!secret){
        secret = promptDMKey(dmKey, dmKey.split("_").find(n=>n!==currentUser));
        if(!secret) return;
      }

      const { cipher, salt } = await encryptOTP(text, secret, dmKey);

      await addDoc(collection(db,"messages"), {
        cipher,
        salt,
        room: dmKey,
        sender: currentUser,
        timestamp: serverTimestamp()
      });

    } else {
      const pt = utf8ToBytes(text);
      const cipher = base64FromBytes(pt);

      await addDoc(collection(db,"messages"), {
        cipher,
        salt: "public",
        room: curRoom,
        sender: currentUser,
        timestamp: serverTimestamp()
      });
    }

  } catch(e){
    console.error("sendMessageEncrypted error", e);
    alert("Erreur lors de l'envoi du message.");
  }
}

/* ============================================================
   ENVOI IMAGE (DM chiffré + public)
============================================================ */

async function sendImageEncrypted(file){
  if(!file || !currentUser) return;

  try {
    const base = await compressImageToBase64(file);

    if(isPrivateCurrent){
      const dmKey = curRoom;
      let secret = getDMKey(dmKey);
      if(!secret){
        secret = promptDMKey(dmKey, dmKey.split("_").find(n=>n!==currentUser));
        if(!secret) return;
      }

      const { cipher, salt } = await encryptOTP(base, secret, dmKey);

      await addDoc(collection(db,"messages"), {
        cipher,
        salt,
        room: dmKey,
        sender: currentUser,
        timestamp: serverTimestamp()
      });

    } else {
      const cipher = base64FromBytes(utf8ToBytes(base));

      await addDoc(collection(db,"messages"), {
        cipher,
        salt: "public",
        room: curRoom,
        sender: currentUser,
        timestamp: serverTimestamp()
      });
    }

  } catch(e){
    console.error("sendImageEncrypted error", e);
    alert("Erreur lors de l'envoi de l'image.");
  }
}

/* ============================================================
   RENDU MESSAGE
============================================================ */

function renderMessageElement(sender, html, isOwn){
  const div = document.createElement("div");
  div.className = "msg-block" + (isOwn ? " own" : "");

  const info = document.createElement("div");
  info.className = "msg-info";
  const now = new Date();
  info.innerHTML = `<span>${sender}</span><span>${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}</span>`;

  const content = document.createElement("div");
  content.className = "msg-text";
  content.innerHTML = html;

  div.appendChild(info);
  div.appendChild(content);
  return div;
}

/* ============================================================
   AUTH (corrigé)
============================================================ */

let authMode = "login";

async function handleLogin(){
  const codeInput = byId("auth-code");
  if(!codeInput) return;

  const code = codeInput.value.trim().toLowerCase();
  if(!code){ alert("Entre un pseudo."); return; }

  try {
    const ref = doc(db,"users",code);
    const snap = await getDoc(ref);

    if(authMode === "login"){
      if(!snap.exists()){
        alert("Ce profil n'existe pas.");
        return;
      }
      currentUser = code;
      localStorage.setItem("tt_user", code);
      byId("auth-screen").style.display = "none";
      byId("main-app").style.display = "flex";
      enterRoom("général", false);

    } else {
      if(snap.exists()){
        alert("Ce pseudo existe déjà.");
        return;
      }
      await setDoc(ref, { code });
      currentUser = code;
      localStorage.setItem("tt_user", code);
      byId("auth-screen").style.display = "none";
      byId("main-app").style.display = "flex";
      enterRoom("général", false);
    }

  } catch(e){
    console.error("handleLogin error", e);
    alert("Erreur lors de la connexion.");
  }
}

function updateAuthUI(){
  const title = byId("auth-title");
  const toggle = byId("auth-toggle");
  const btn = byId("btn-login");
  if(!title || !toggle || !btn) return;

  if(authMode === "login"){
    title.innerText = "Connexion";
    toggle.innerText = "Créer un profil";
    btn.innerText = "Se connecter";
  } else {
    title.innerText = "Inscription";
    toggle.innerText = "J'ai déjà un profil";
    btn.innerText = "S'inscrire";
  }
}
/* ============================================================
   ROOMS / CONTACTS STATE
============================================================ */

let roomsCache = [];
let contactsCache = [];
const lastMessagesByRoom = new Map();
const lastMessagesByDM = new Map();

/* ============================================================
   RENDER ROOMS & CONTACTS
============================================================ */

function renderRoomsTiles(){
  const g = byId("rooms-grid");
  if(!g) return;
  g.innerHTML = "";
  const search = (byId("rooms-search")?.value || "").toLowerCase();

  roomsCache.forEach(r => {
    if(!r.name) return;
    const previews = lastMessagesByRoom.get(r.name) || [];
    const previewText = previews.map(m=>`${m.sender}: ${m.text}`).join(" • ").slice(0,120);
    const haystack = (r.name + " " + previewText).toLowerCase();
    if(search && !haystack.includes(search)) return;

    const t = document.createElement("div");
    t.className = "tile";
    t.innerHTML = `
      <div class="title"><span># ${r.name}</span>${r.pass ? '<span class="lock-badge">🔒</span>' : ''}</div>
      <div class="tile-preview">${previewText || '<span class="muted">Aucun message</span>'}</div>
    `;
    t.onclick = () => enterRoom(r.name, false);
    g.appendChild(t);
  });
}

function renderContactsTiles(){
  const g = byId("contacts-grid");
  if(!g || !currentUser) return;
  g.innerHTML = "";
  const search = (byId("contacts-search")?.value || "").toLowerCase();

  const setNames = new Set();
  contactsCache.forEach(c => {
    if(!c.owner || !c.name) return;
    if(c.owner === currentUser) setNames.add(c.name);
    if(c.name === currentUser) setNames.add(c.owner);
  });

  Array.from(setNames).forEach(name => {
    const dmKey = [currentUser, name].sort().join("_");
    const previews = lastMessagesByDM.get(dmKey) || [];
    const previewText = previews.map(m=>`${m.sender}: ${m.text}`).join(" • ").slice(0,120);
    const haystack = (name + " " + previewText).toLowerCase();
    if(search && !haystack.includes(search)) return;

    const t = document.createElement("div");
    t.className = "tile";
    t.innerHTML = `
      <div class="title"><span>@ ${name}</span></div>
      <div class="tile-preview">${previewText || '<span class="muted">Aucun message</span>'}</div>
    `;
    t.onclick = () => enterRoom(name, true);
    g.appendChild(t);
  });
}

/* ============================================================
   SNAPSHOTS ROOMS / CONTACTS / SUMMARY
============================================================ */

function setupRoomsSnapshot(){
  onSnapshot(collection(db,"rooms"), snap => {
    roomsCache = [];
    snap.forEach(d => roomsCache.push({ ...d.data(), _id: d.id }));
    renderRoomsTiles();
  });
}

function setupContactsSnapshot(){
  onSnapshot(collection(db,"contacts"), snap => {
    contactsCache = [];
    snap.forEach(d => contactsCache.push({ ...d.data(), _id: d.id }));
    renderContactsTiles();
  });
}

function setupMessagesSummarySnapshot(){
  const qAll = query(collection(db,"messages"), orderBy("timestamp","asc"));
  onSnapshot(qAll, snap => {
    lastMessagesByRoom.clear();
    lastMessagesByDM.clear();

    snap.forEach(d => {
      const m = d.data();
      const room = m.room;
      if(!room) return;
      const entry = {
        sender: m.sender || "???",
        text: m.salt && m.salt !== "public" ? "[chiffré]" : "[message]"
      };

      if(room.includes("_") && room.split("_").length === 2){
        const arr = lastMessagesByDM.get(room) || [];
        arr.push(entry);
        if(arr.length > 3) arr.shift();
        lastMessagesByDM.set(room, arr);
      } else {
        const arr = lastMessagesByRoom.get(room) || [];
        arr.push(entry);
        if(arr.length > 3) arr.shift();
        lastMessagesByRoom.set(room, arr);
      }
    });

    renderRoomsTiles();
    renderContactsTiles();
  });
}

/* ============================================================
   ENSURE GENERAL ROOM
============================================================ */

async function ensureGeneralRoom(){
  try {
    const qGen = query(collection(db,"rooms"), where("name","==","général"), limit(1));
    const snap = await getDocs(qGen);
    if(snap.empty){
      await addDoc(collection(db,"rooms"), { name:"général", pass:"", owner:"system" });
    }
  } catch(e){
    console.error("ensureGeneralRoom error", e);
  }
}

/* ============================================================
   WALLPAPERS FIRESTORE (simple, sans crop pour l’instant)
============================================================ */

async function loadChatBackground(roomName, isPrivate){
  const view = byId("view-chat");
  if(!view) return;

  const key = isPrivate ? curRoom : roomName;
  const col = isPrivate ? "dmBackgrounds" : "roomBackgrounds";
  const ref = doc(db, col, key);

  try {
    const snap = await getDoc(ref);
    if(!snap.exists()){
      await setDoc(ref, { background: "" });
      view.style.backgroundImage = "none";
      return;
    }
    const data = snap.data();
    if(data && data.background){
      view.style.backgroundImage = `url(${data.background})`;
    } else {
      view.style.backgroundImage = "none";
    }
  } catch(e){
    console.error("loadChatBackground error", e);
    view.style.backgroundImage = "none";
  }
}

async function setBackgroundForCurrentChat(file){
  if(!file || !currentUser) return;
  try {
    const dataUrl = await compressImageToBase64(file, 1200, 900, 0.08);
    const col = isPrivateCurrent ? "dmBackgrounds" : "roomBackgrounds";
    const key = curRoom;
    const ref = doc(db, col, key);
    await setDoc(ref, { background: dataUrl });
    await loadChatBackground(isPrivateCurrent ? curRoom.split("_").find(n=>n!==currentUser) : curRoom, isPrivateCurrent);
    alert("Fond mis à jour.");
  } catch(e){
    console.error("setBackgroundForCurrentChat error", e);
    alert("Erreur lors de la mise à jour du fond.");
  }
}

async function resetBackgroundForCurrentChat(){
  if(!currentUser) return;
  try {
    const col = isPrivateCurrent ? "dmBackgrounds" : "roomBackgrounds";
    const key = curRoom;
    const ref = doc(db, col, key);
    await setDoc(ref, { background: "" });
    await loadChatBackground(isPrivateCurrent ? curRoom.split("_").find(n=>n!==currentUser) : curRoom, isPrivateCurrent);
    alert("Fond réinitialisé.");
  } catch(e){
    console.error("resetBackgroundForCurrentChat error", e);
    alert("Erreur lors de la réinitialisation du fond.");
  }
}

/* ============================================================
   ENTER ROOM (public + DM)
============================================================ */

function escapeHtml(s){
  return s.replace(/[&<>"']/g, m=>{
    switch(m){
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return m;
    }
  });
}

function enterRoom(name, isPrivate=false){
  if(!currentUser){
    alert("Connecte-toi d'abord.");
    return;
  }

  if(isPrivate){
    curRoom = [currentUser, name].sort().join("_");
    isPrivateCurrent = true;
  } else {
    curRoom = name;
    isPrivateCurrent = false;
  }

  const header = byId("chat-header");
  if(header) header.innerText = (isPrivate ? "@ " : "# ") + name;

  switchTab("chat");

  if(unsubChat) unsubChat();

  const qMsg = query(
    collection(db,"messages"),
    where("room","==",curRoom),
    orderBy("timestamp","asc")
  );

  unsubChat = onSnapshot(qMsg, async snap => {
    const box = byId("chat-messages");
    if(!box) return;
    box.innerHTML = "";

    for(const d of snap.docs){
      const m = d.data();
      const sender = m.sender || "???";
      const isOwn = sender === currentUser;
      let html = "";

      try {
        if(isPrivateCurrent){
          const dmKey = curRoom;
          const secret = getDMKey(dmKey);
          if(!secret){
            html = `<em class="muted">Message chiffré. <button class="enter-key-btn" data-dm="${dmKey}">Entrer clé</button></em>`;
          } else {
            const plain = await decryptOTP(m.cipher, secret, dmKey, m.salt);
            if(plain.startsWith("data:image/")){
              html = `<img src="${plain}" class="msg-img">`;
            } else {
              html = escapeHtml(plain);
            }
          }
        } else {
          const cipherB64 = m.cipher || "";
          if(cipherB64){
            const bytes = bytesFromBase64(cipherB64);
            const txt = bytesToUtf8(bytes);
            if(txt.startsWith("data:image/")){
              html = `<img src="${txt}" class="msg-img">`;
            } else {
              html = escapeHtml(txt);
            }
          } else {
            html = "<em class='muted'>Message vide</em>";
          }
        }
      } catch(e){
        console.error("decrypt error", e);
        html = "<em class='muted'>Impossible de déchiffrer</em>";
      }

      const el = renderMessageElement(sender, html, isOwn);
      box.appendChild(el);
    }

    qsa(".enter-key-btn").forEach(btn=>{
      btn.onclick = () => {
        const dm = btn.dataset.dm;
        promptDMKey(dm, dm.split("_").find(n=>n!==currentUser));
        enterRoom(name, isPrivate);
      };
    });

    const parent = box.parentElement;
    if(parent) parent.scrollTop = parent.scrollHeight;
  });

  loadChatBackground(name, isPrivate);
}

/* ============================================================
   CONTACTS
============================================================ */

async function suggestUsers(prefix){
  if(!prefix || prefix.length < 1) return [];
  try {
    const snap = await getDocs(collection(db,"users"));
    const all = snap.docs.map(d=>d.id);
    return all.filter(u => u.startsWith(prefix.toLowerCase()));
  } catch(e){
    console.error("suggestUsers error", e);
    return [];
  }
}

function renderSuggestions(list){
  const box = byId("contact-suggestions");
  if(!box) return;
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
  if(!currentUser){ alert("Connecte-toi d'abord."); return; }
  const name = byId("contact-name-input").value.trim().toLowerCase();
  if(!name || name === currentUser) return;

  try {
    const uRef = doc(db,"users",name);
    const uDoc = await getDoc(uRef);
    if(!uDoc.exists()){
      alert("Ce contact n'existe pas.");
      return;
    }

    const q1 = query(collection(db,"contacts"), where("owner","==",currentUser), where("name","==",name));
    const snap = await getDocs(q1);
    if(!snap.empty){
      alert("Contact déjà ajouté.");
      byId("contact-name-input").value = "";
      return;
    }

    await addDoc(collection(db,"contacts"), { owner: currentUser, name });
    byId("contact-name-input").value = "";
    alert("Contact ajouté.");
  } catch(e){
    console.error("addContact error", e);
    alert("Erreur lors de l'ajout du contact.");
  }
}

/* ============================================================
   UI / INIT
============================================================ */

function switchTab(tab){
  qsa(".view-section").forEach(v=>v.classList.remove("active"));
  const view = byId("view-"+tab);
  if(view) view.classList.add("active");

  qsa(".nav-btn").forEach(b=>b.classList.remove("active"));
  const btn = qsa(".nav-btn").find(b=>b.dataset.tab===tab);
  if(btn) btn.classList.add("active");

  const wpBtn = byId("btn-wallpaper");
  if(wpBtn) wpBtn.style.display = (tab === "chat") ? "block" : "none";
}

function initUI(){
  const loginBtn = byId("btn-login");
  if(loginBtn) loginBtn.onclick = handleLogin;

  const authToggle = byId("auth-toggle");
  if(authToggle) authToggle.onclick = () => {
    authMode = authMode === "login" ? "register" : "login";
    updateAuthUI();
  };

  const logoutBtn = byId("btn-logout");
  if(logoutBtn) logoutBtn.onclick = () => {
    localStorage.removeItem("tt_user");
    location.reload();
  };

  const sendBtn = byId("send-btn");
  if(sendBtn) sendBtn.onclick = () => {
    const input = byId("chat-input");
    const txt = input.value;
    sendMessageEncrypted(txt);
    input.value = "";
  };

  const chatInput = byId("chat-input");
  if(chatInput) chatInput.addEventListener("keydown", e=>{
    if(e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      const txt = chatInput.value;
      sendMessageEncrypted(txt);
      chatInput.value = "";
    }
  });

  const attachBtn = byId("btn-attach");
  const fileInput = byId("file-input");
  if(attachBtn && fileInput){
    attachBtn.onclick = () => fileInput.click();
    fileInput.onchange = e => {
      const f = e.target.files[0];
      if(f) sendImageEncrypted(f);
      e.target.value = "";
    };
  }

  const bgBtn = byId("btn-wallpaper");
  const bgInput = byId("bg-file-input");
  if(bgBtn && bgInput){
    bgBtn.onclick = () => bgInput.click();
    bgInput.onchange = e => {
      const f = e.target.files[0];
      if(f) setBackgroundForCurrentChat(f);
      e.target.value = "";
    };
  }

  const resetBgBtn = byId("btn-reset-wallpaper");
  if(resetBgBtn) resetBgBtn.onclick = resetBackgroundForCurrentChat;

  const addContactBtn = byId("btn-add-contact");
  if(addContactBtn) addContactBtn.onclick = addContact;

  const contactInput = byId("contact-name-input");
  if(contactInput) contactInput.addEventListener("input", async e=>{
    const val = e.target.value.trim().toLowerCase();
    const list = await suggestUsers(val);
    renderSuggestions(list);
  });

  const roomsSearch = byId("rooms-search");
  if(roomsSearch) roomsSearch.addEventListener("input", ()=> renderRoomsTiles());
  const contactsSearch = byId("contacts-search");
  if(contactsSearch) contactsSearch.addEventListener("input", ()=> renderContactsTiles());

  qsa(".nav-btn").forEach(b=>{
    b.onclick = () => switchTab(b.dataset.tab);
  });

  updateAuthUI();
}

async function initApp(){
  initUI();
  await ensureGeneralRoom();
  setupRoomsSnapshot();
  setupContactsSnapshot();
  setupMessagesSummarySnapshot();

  if(currentUser){
    byId("auth-screen").style.display = "none";
    byId("main-app").style.display = "flex";
    enterRoom("général", false);
  } else {
    byId("auth-screen").style.display = "flex";
    byId("main-app").style.display = "none";
  }
}

/* ============================================================
   START
============================================================ */

window.enterRoom = enterRoom;
window.setBackgroundForCurrentChat = setBackgroundForCurrentChat;
window.resetBackgroundForCurrentChat = resetBackgroundForCurrentChat;
window.initApp = initApp;

initApp();

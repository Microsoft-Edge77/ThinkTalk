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
   Remplace cfg par ta config si besoin
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
   UTILITAIRES RAPIDES
============================================================ */

const byId = id => document.getElementById(id);
const qsa = sel => Array.from(document.querySelectorAll(sel));
const debounce = (fn, wait=200) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), wait); }; };
const randHex = (len=16) => {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b=>b.toString(16).padStart(2,"0")).join("");
};
const utf8ToBytes = str => new TextEncoder().encode(str);
const bytesToUtf8 = bytes => new TextDecoder().decode(bytes);
const base64FromBytes = bytes => {
  let binary = "";
  const len = bytes.length;
  for(let i=0;i<len;i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};
const bytesFromBase64 = b64 => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return arr;
};

/* ============================================================
   ETAT GLOBAL
============================================================ */

let currentUser = localStorage.getItem("tt_user") || null;
let curRoom = "général";
let isPrivateCurrent = false;
let unsubChat = null;
let selectedMsgId = null;

/* DM KEYS
   Stockage local uniquement. Clé par DM (clé_dm_<dmKey>)
   dmKey format: sorted usernames joined by underscore (alice_bob)
*/
const dmKeyStoragePrefix = "tt_dmkey_";

/* ============================================================
   OTP SIMPLIFIÉ PAR DM
   - deriveKeystream : HKDF-like simple derivation using SHA-256
   - xorBytes : XOR deux Uint8Array
   - encryptOTP / decryptOTP : XOR plaintext with keystream
   - salt : random hex short (16 bytes)
============================================================ */

/**
 * deriveKeystream
 * Derive a keystream of requested length (bytes) from secret + room + salt
 * Uses repeated SHA-256 chaining to produce enough bytes.
 */
async function deriveKeystream(secret, room, salt, length){
  // seed = secret || '|' || room || '|' || salt
  const seedStr = `${secret}|${room}|${salt}`;
  let seed = utf8ToBytes(seedStr);
  let out = new Uint8Array(0);
  let counter = 0;
  while(out.length < length){
    // data = seed || counter
    const ctr = new Uint8Array([counter & 0xff, (counter>>8)&0xff, (counter>>16)&0xff, (counter>>24)&0xff]);
    const data = new Uint8Array(seed.length + ctr.length);
    data.set(seed,0); data.set(ctr, seed.length);
    const hashBuf = await crypto.subtle.digest("SHA-256", data);
    const hash = new Uint8Array(hashBuf);
    const newOut = new Uint8Array(out.length + hash.length);
    newOut.set(out,0); newOut.set(hash, out.length);
    out = newOut;
    counter++;
    if(counter > 1024) throw new Error("deriveKeystream: too many iterations");
  }
  return out.slice(0, length);
}

/**
 * xorBytes
 * XOR two Uint8Array, returns new Uint8Array
 */
function xorBytes(a, b){
  const n = Math.min(a.length, b.length);
  const out = new Uint8Array(n);
  for(let i=0;i<n;i++) out[i] = a[i] ^ b[i];
  return out;
}

/**
 * encryptOTP
 * plaintext string -> returns { cipherB64, salt }
 */
async function encryptOTP(plaintext, secret, room){
  const salt = randHex(12); // 12 bytes hex = 24 chars
  const ptBytes = utf8ToBytes(plaintext);
  const keystream = await deriveKeystream(secret, room, salt, ptBytes.length);
  const cipherBytes = xorBytes(ptBytes, keystream);
  const cipherB64 = base64FromBytes(cipherBytes);
  return { cipher: cipherB64, salt };
}

/**
 * decryptOTP
 * cipherB64 + salt -> plaintext string (throws if key wrong)
 */
async function decryptOTP(cipherB64, secret, room, salt){
  const cipherBytes = bytesFromBase64(cipherB64);
  const keystream = await deriveKeystream(secret, room, salt, cipherBytes.length);
  const ptBytes = xorBytes(cipherBytes, keystream);
  return bytesToUtf8(ptBytes);
}

/* ============================================================
   GESTION DES CLES DM
   - setDMKey(dmKey, secret)
   - getDMKey(dmKey)
   - promptDMKey(dmKey) : UI prompt minimal
============================================================ */

function dmKeyStorageKey(dmKey){
  return dmKeyStoragePrefix + dmKey;
}

function setDMKey(dmKey, secret){
  if(!dmKey || !secret) return;
  try {
    localStorage.setItem(dmKeyStorageKey(dmKey), secret);
  } catch(e){
    console.error("setDMKey error", e);
  }
}

function getDMKey(dmKey){
  try {
    return localStorage.getItem(dmKeyStorageKey(dmKey));
  } catch(e){
    return null;
  }
}

/**
 * promptDMKey
 * Minimal prompt UI: opens a popup where user enters the DM key.
 * Stores it locally via setDMKey.
 */
function promptDMKey(dmKey, displayName){
  // displayName is the visible name of the DM (other user)
  const title = `Clé DM pour ${displayName}`;
  const msg = `Entrez la clé secrète pour la conversation privée avec ${displayName}. Cette clé n'est jamais envoyée au serveur.`;
  // simple prompt fallback
  const secret = prompt(`${title}\n\n${msg}\n\nClé :`);
  if(secret && secret.length > 0){
    setDMKey(dmKey, secret);
    showMessage("Clé enregistrée localement.");
    return secret;
  } else {
    showMessage("Clé non fournie. Impossible de déchiffrer les messages.");
    return null;
  }
}

/* ============================================================
   SEND MESSAGE (CHIFFRÉ OTP) et SEND IMAGE
   - sendMessageEncrypted
   - sendImageEncrypted (image compressed to base64 then encrypted)
============================================================ */

async function sendMessageEncrypted(plainText){
  if(!currentUser) { showMessage("Connecte-toi d'abord."); return; }
  if(!plainText || plainText.trim().length === 0) return;

  try {
    if(isPrivateCurrent){
      // DM: curRoom is sorted "alice_bob"
      const dmKey = curRoom;
      let secret = getDMKey(dmKey);
      if(!secret){
        // ask user for key
        secret = promptDMKey(dmKey, dmKey.split("_").find(n=>n!==currentUser) || dmKey);
        if(!secret) return;
      }
      const { cipher, salt } = await encryptOTP(plainText, secret, dmKey);
      await addDoc(collection(db,"messages"), {
        cipher,
        salt,
        room: dmKey,
        sender: currentUser,
        timestamp: serverTimestamp()
      });
    } else {
      // Public room: we store plaintext encrypted with a room-shared secret only if you want.
      // For now, public rooms keep plaintext-like behavior but we will store as cipher with empty salt to keep rules consistent.
      // Use a simple server-visible cipher placeholder (not secret) to satisfy rules: store cipher as base64 of plaintext
      const ptBytes = utf8ToBytes(plainText);
      const cipherB64 = base64FromBytes(ptBytes);
      await addDoc(collection(db,"messages"), {
        cipher: cipherB64,
        salt: "",
        room: curRoom,
        sender: currentUser,
        timestamp: serverTimestamp()
      });
    }
  } catch(e){
    console.error("sendMessageEncrypted error", e);
    showMessage("Erreur lors de l'envoi du message.");
  }
}

/**
 * compressImageToBase64
 * Resize + compress image to JPEG base64. Used for images and wallpapers.
 */
function compressImageToBase64(file, maxW=900, maxH=700, quality=0.08){
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = e=>{
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

/**
 * sendImageEncrypted
 * Compress image to base64 then encrypt with OTP for DM or store base64 for room.
 */
async function sendImageEncrypted(file){
  if(!file || !currentUser) return;
  try {
    const dataUrl = await compressImageToBase64(file, 900, 700, 0.08);
    // For DM: encrypt the base64 string
    if(isPrivateCurrent){
      const dmKey = curRoom;
      let secret = getDMKey(dmKey);
      if(!secret){
        secret = promptDMKey(dmKey, dmKey.split("_").find(n=>n!==currentUser) || dmKey);
        if(!secret) return;
      }
      const { cipher, salt } = await encryptOTP(dataUrl, secret, dmKey);
      await addDoc(collection(db,"messages"), {
        cipher,
        salt,
        room: dmKey,
        sender: currentUser,
        timestamp: serverTimestamp()
      });
    } else {
      // public room: store base64 as cipher with empty salt
      const cipherB64 = base64FromBytes(utf8ToBytes(dataUrl));
      await addDoc(collection(db,"messages"), {
        cipher: cipherB64,
        salt: "",
        room: curRoom,
        sender: currentUser,
        timestamp: serverTimestamp()
      });
    }
  } catch(e){
    console.error("sendImageEncrypted error", e);
    showMessage("Erreur lors de l'envoi de l'image.");
  }
}

/* ============================================================
   MESSAGES SNAPSHOT + DÉCHIFFREMENT À LA VOLÉE
   - setupMessagesSnapshot : écoute messages et déchiffre si DM
============================================================ */

function renderMessageElement(sender, contentHtml, isOwn){
  const div = document.createElement("div");
  div.className = "msg-block" + (isOwn ? " own" : "");
  const info = document.createElement("div");
  info.className = "msg-info";
  const now = new Date();
  const hh = String(now.getHours()).padStart(2,"0");
  const mm = String(now.getMinutes()).padStart(2,"0");
  info.innerHTML = `<span>${sender}</span><span>${hh}:${mm}</span>`;
  const content = document.createElement("div");
  content.className = "msg-text";
  content.innerHTML = contentHtml;
  div.appendChild(info);
  div.appendChild(content);
  return div;
}

function setupMessagesSnapshot(){
  if(unsubChat) unsubChat();
  const qMsg = query(collection(db,"messages"), orderBy("timestamp","asc"));
  unsubChat = onSnapshot(qMsg, async (snap) => {
    const box = byId("chat-messages");
    if(!box) return;
    box.innerHTML = "";
    for(const d of snap.docs){
      const m = d.data();
      const room = m.room;
      const sender = m.sender || "unknown";
      const isOwn = sender === currentUser;
      let contentHtml = "";

      try {
        if(room.includes("_") && room.split("_").length === 2){
          // DM: attempt decrypt using local key
          const dmKey = room;
          const secret = getDMKey(dmKey);
          if(!secret){
            // show placeholder and a button to enter key
            contentHtml = `<em class="muted">Message chiffré. <button class="enter-key-btn" data-dm="${dmKey}">Entrer clé</button></em>`;
          } else {
            const plain = await decryptOTP(m.cipher, secret, dmKey, m.salt);
            // if looks like dataURL (image), render image
            if(plain.startsWith("data:image/")){
              contentHtml = `<img src="${plain}" class="msg-img">`;
            } else {
              contentHtml = escapeHtml(plain);
            }
          }
        } else {
          // Public room: cipher stored as base64 of plaintext or image
          const cipherB64 = m.cipher || "";
          if(cipherB64){
            const bytes = bytesFromBase64(cipherB64);
            const txt = bytesToUtf8(bytes);
            if(txt.startsWith("data:image/")){
              contentHtml = `<img src="${txt}" class="msg-img">`;
            } else {
              contentHtml = escapeHtml(txt);
            }
          } else {
            contentHtml = "<em class='muted'>Message vide</em>";
          }
        }
      } catch(e){
        console.error("decrypt/render error", e);
        contentHtml = `<em class="muted">Impossible de déchiffrer le message</em>`;
      }

      const el = renderMessageElement(sender, contentHtml, isOwn);
      box.appendChild(el);
    }

    // attach listeners for enter-key buttons
    qsa(".enter-key-btn").forEach(btn=>{
      btn.onclick = (ev)=>{
        const dm = btn.dataset.dm;
        promptDMKey(dm, dm.split("_").find(n=>n!==currentUser) || dm);
        // after entering key, we re-run snapshot rendering by calling setupMessagesSnapshot again
        // but to avoid re-subscribing, simply call setupMessagesSnapshot to refresh UI
        setupMessagesSnapshot();
      };
    });

    // scroll to bottom
    const parent = box.parentElement;
    if(parent) parent.scrollTop = parent.scrollHeight;
  });
}

/* ============================================================
   HELPERS
============================================================ */

function escapeHtml(s){
  return s.replace(/[&<>"']/g, (m)=> {
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

/* ============================================================
   POPUPS / MESSAGES UI MINIMAL (utilisé par functions above)
============================================================ */

function showMessage(text, title="INFO"){
  // minimal: alert fallback if no popup
  try {
    const mt = byId("msg-text");
    const tt = byId("msg-title");
    if(mt && tt){
      tt.innerText = title;
      mt.innerText = text;
      openPopup("pop-message","card-message");
      return;
    }
  } catch(e){}
  alert(`${title}\n\n${text}`);
}

/* ============================================================
   EXPORTS FOR PARTIE 2
   Partie 2 contiendra : enterRoom, rooms, contacts, wallpapers Firestore,
   ensureGeneralRoom, initUI, initApp, switchTab, etc.
============================================================ */

// Expose some functions to global scope for UI hooks in Partie 2
window.sendMessageEncrypted = sendMessageEncrypted;
window.sendImageEncrypted = sendImageEncrypted;
window.setupMessagesSnapshot = setupMessagesSnapshot;
window.setDMKey = setDMKey;
window.getDMKey = getDMKey;
window.promptDMKey = promptDMKey;
window.compressImageToBase64 = compressImageToBase64;
/* ============================================================
   POPUPS MINIMAL (openPopup / closePopups) + confirm
============================================================ */

function openPopup(popId, cardId){
  const pop = byId(popId), card = byId(cardId);
  if(!pop || !card) return;
  pop.style.display = "flex";
  setTimeout(()=> card.classList.add("visible"), 40);
}

function closePopups(){
  qsa(".popup-overlay").forEach(p=> p.style.display = "none");
  qsa(".popup-card").forEach(c=> c.classList.remove("visible"));
}

let confirmCallback = null;
function showConfirm(text, onYes, title="CONFIRMATION"){
  confirmCallback = onYes;
  const t = byId("confirm-text"), tt = byId("confirm-title");
  if(tt) tt.innerText = title;
  if(t) t.innerText = text;
  openPopup("pop-confirm","card-confirm");
}

/* ============================================================
   WALLPAPER FIRESTORE (roomBackgrounds / dmBackgrounds)
   - loadChatBackground(roomName, isPrivateChat)
   - setBackgroundForCurrentChat(file)
   - resetBackgroundForCurrentChat()
   - auto-create doc if missing
============================================================ */

async function loadChatBackground(roomName, isPrivateChat){
  const view = byId("view-chat");
  if(!view) return;

  view.style.backgroundSize = "cover";
  view.style.backgroundPosition = "center";
  view.style.backgroundRepeat = "no-repeat";

  const key = isPrivateChat ? curRoom : roomName;
  const col = isPrivateChat ? "dmBackgrounds" : "roomBackgrounds";
  const ref = doc(db, col, key);

  try {
    const snap = await getDoc(ref);
    if(!snap.exists()){
      // create empty doc to avoid future 404s
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
    showMessage("Fond mis à jour.");
  } catch(e){
    console.error("setBackgroundForCurrentChat error", e);
    showMessage("Erreur lors de la mise à jour du fond d'écran.");
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
    showMessage("Fond réinitialisé.");
  } catch(e){
    console.error("resetBackgroundForCurrentChat error", e);
    showMessage("Impossible de réinitialiser le fond.");
  }
}

/* ============================================================
   ENTER ROOM (PUBLIC + DM) — subscription per-room
   - enterRoom(name, isPrivateChat)
   - unsubscribes previous listener
   - loads wallpaper
   - auto-ensure room exists for public rooms
============================================================ */

async function enterRoom(name, isPrivateChat=false){
  if(!currentUser){ showMessage("Connecte-toi d'abord."); return; }

  // For public rooms, ensure existence
  if(!isPrivateChat){
    try {
      const rSnap = await getDocs(query(collection(db,"rooms"), where("name","==",name), limit(1)));
      if(rSnap.empty){
        await addDoc(collection(db,"rooms"), { name, pass: "", owner: currentUser });
      }
    } catch(e){
      console.error("enterRoom ensure room error", e);
    }
  }

  // set state
  curRoom = isPrivateChat ? [currentUser, name].sort().join("_") : name;
  isPrivateCurrent = isPrivateChat;

  // UI header
  const header = byId("chat-header");
  if(header) header.innerText = (isPrivateChat ? "@ " : "# ") + name;

  // switch to chat view
  switchTab("chat");

  // unsubscribe previous
  if(unsubChat) unsubChat();

  // subscribe to messages for this room only
  const qMsg = query(collection(db,"messages"), where("room","==",curRoom), orderBy("timestamp","asc"));
  unsubChat = onSnapshot(qMsg, async (snap) => {
    const box = byId("chat-messages");
    if(!box) return;
    box.innerHTML = "";

    for(const d of snap.docs){
      const m = d.data();
      const sender = m.sender || "unknown";
      const isOwn = sender === currentUser;
      let contentHtml = "";

      try {
        if(isPrivateCurrent){
          const dmKey = curRoom;
          const secret = getDMKey(dmKey);
          if(!secret){
            contentHtml = `<em class="muted">Message chiffré. <button class="enter-key-btn" data-dm="${dmKey}">Entrer clé</button></em>`;
          } else {
            const plain = await decryptOTP(m.cipher, secret, dmKey, m.salt);
            if(plain.startsWith("data:image/")){
              contentHtml = `<img src="${plain}" class="msg-img">`;
            } else {
              contentHtml = escapeHtml(plain);
            }
          }
        } else {
          // public room: cipher is base64 of plaintext or image
          const cipherB64 = m.cipher || "";
          if(cipherB64){
            const bytes = bytesFromBase64(cipherB64);
            const txt = bytesToUtf8(bytes);
            if(txt.startsWith("data:image/")){
              contentHtml = `<img src="${txt}" class="msg-img">`;
            } else {
              contentHtml = escapeHtml(txt);
            }
          } else {
            contentHtml = "<em class='muted'>Message vide</em>";
          }
        }
      } catch(e){
        console.error("enterRoom decrypt/render error", e);
        contentHtml = `<em class="muted">Impossible de déchiffrer le message</em>`;
      }

      const el = renderMessageElement(sender, contentHtml, isOwn);
      box.appendChild(el);
    }

    // attach enter-key handlers
    qsa(".enter-key-btn").forEach(btn=>{
      btn.onclick = (ev)=>{
        const dm = btn.dataset.dm;
        promptDMKey(dm, dm.split("_").find(n=>n!==currentUser) || dm);
        // refresh messages for this room
        enterRoom(isPrivateCurrent ? (dm.split("_").find(n=>n!==currentUser) || dm) : curRoom, isPrivateCurrent);
      };
    });

    // scroll to bottom
    const parent = box.parentElement;
    if(parent) parent.scrollTop = parent.scrollHeight;
  });

  // load wallpaper for this room
  await loadChatBackground(isPrivateChat ? name : name, isPrivateChat);
}

/* ============================================================
   CREATE ROOM
============================================================ */

async function createRoom(){
  const name = byId("new-room-name").value.trim();
  const pass = byId("new-room-pass").value.trim();
  if(!name) { showMessage("Nom du salon requis."); return; }
  if(!currentUser){ showMessage("Connecte-toi d'abord."); return; }

  try {
    const rSnap = await getDocs(query(collection(db,"rooms"), where("name","==",name), limit(1)));
    if(!rSnap.empty){ showMessage("Un salon avec ce nom existe déjà."); return; }

    await addDoc(collection(db,"rooms"), { name, pass, owner: currentUser });
    closePopups();
    byId("new-room-name").value = "";
    byId("new-room-pass").value = "";
  } catch(e){
    console.error("createRoom error", e);
    showMessage("Erreur lors de la création du salon.");
  }
}

/* ============================================================
   CONTACTS
   - suggestUsers(prefix)
   - addContact()
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

async function addContact(){
  if(!currentUser){ showMessage("Connecte-toi d'abord."); return; }
  const name = byId("contact-name-input").value.trim().toLowerCase();
  if(!name || name === currentUser) return;

  try {
    const uRef = doc(db,"users",name);
    const uDoc = await getDoc(uRef);
    if(!uDoc.exists()){ showMessage("Ce contact n'existe pas."); return; }

    // check duplicates
    const snap = await getDocs(query(collection(db,"contacts"), where("owner","==", currentUser), where("name","==", name)));
    if(!snap.empty){ showMessage("Contact déjà ajouté."); byId("contact-name-input").value=""; return; }

    await addDoc(collection(db,"contacts"), { owner: currentUser, name });
    byId("contact-name-input").value = "";
    showMessage("Contact ajouté.");
  } catch(e){
    console.error("addContact error", e);
    showMessage("Erreur lors de l'ajout du contact.");
  }
}

/* ============================================================
   RENDER ROOMS & CONTACTS (uses roomsCache & contactsCache)
   - renderRoomsTiles()
   - renderContactsTiles()
============================================================ */

let roomsCache = [];
let contactsCache = [];
const lastMessagesByRoom = new Map();
const lastMessagesByDM = new Map();

function renderRoomsTiles(){
  const g = byId("rooms-grid");
  if(!g) return;
  g.innerHTML = "";
  const search = (byId("rooms-search")?.value || "").toLowerCase();

  roomsCache.forEach((r) => {
    if(!r.name) return;
    const previews = lastMessagesByRoom.get(r.name) || [];
    const previewText = previews.map(m=>`${m.sender}: ${m.text}`).join(" • ").slice(0,120);
    const haystack = (r.name + " " + previewText).toLowerCase();
    if(search && !haystack.includes(search)) return;

    const t = document.createElement("div");
    t.className = "tile";
    t.innerHTML = `
      <div class="title"><span># ${r.name}</span> ${r.pass ? '<span class="lock-badge">🔒</span>' : ''}</div>
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
    const haystack = (name + " " + previewText).toLowerCase();
    if(search && !haystack.includes(search)) return;

    const t = document.createElement("div");
    t.className = "tile";
    t.innerHTML = `
      <div class="title"><span>@ ${name}</span></div>
      <div class="tile-preview">${previewText || '<span class="muted">Aucun message</span>'}</div>
    `;
    t.onclick = () => {
      // open DM: pass the other user's name
      enterRoom(name, true);
    };
    g.appendChild(t);
  });
}

/* ============================================================
   SNAPSHOTS: rooms, contacts, messages summary
   - setupRoomsSnapshot()
   - setupContactsSnapshot()
   - setupMessagesSummarySnapshot() : keeps lastMessagesByRoom/DM
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
      contactsCache.push({ ...c, _id: d.id });
    });
    renderContactsTiles();
  });
}

function setupMessagesSummarySnapshot(){
  const qAll = query(collection(db,"messages"), orderBy("timestamp","asc"));
  onSnapshot(qAll, (snap) => {
    lastMessagesByRoom.clear();
    lastMessagesByDM.clear();

    snap.forEach((d) => {
      const m = d.data();
      const room = m.room;
      if(!room) return;
      const entry = { sender: m.sender, text: (m.salt ? "[chiffré]" : (m.cipher ? "[image/texte]" : "")) };

      if(room.includes("_") && room.split("_").length === 2){
        const arr = lastMessagesByDM.get(room) || [];
        arr.push(entry);
        if(arr.length>3) arr.shift();
        lastMessagesByDM.set(room, arr);
      } else {
        const arr = lastMessagesByRoom.get(room) || [];
        arr.push(entry);
        if(arr.length>3) arr.shift();
        lastMessagesByRoom.set(room, arr);
      }
    });

    renderRoomsTiles();
    renderContactsTiles();
  });
}

/* ============================================================
   ENSURE GENERAL ROOM + DEFAULT BACKGROUNDS
============================================================ */

async function ensureGeneralRoom(){
  try {
    const rSnap = await getDocs(query(collection(db,"rooms"), where("name","==","général"), limit(1)));
    if(rSnap.empty){
      await addDoc(collection(db,"rooms"), { name: "général", pass: "", owner: "system" });
    }
    // ensure default background doc exists for général
    const ref = doc(db,"roomBackgrounds","général");
    const snap = await getDoc(ref);
    if(!snap.exists()) await setDoc(ref, { background: "" });
  } catch(e){
    console.error("ensureGeneralRoom error", e);
  }
}

/* ============================================================
   UI INIT & HOOKS
   - initUI()
   - initApp()
   - switchTab()
============================================================ */

function initUI(){
  // nav buttons
  qsa(".nav-btn").forEach((btn)=> btn.addEventListener("click", ()=> switchTab(btn.dataset.tab)));

  // popup openers
  const openSession = byId("btn-open-session");
  if(openSession) openSession.addEventListener("click", ()=> openPopup("pop-logout","card-logout"));

  const openCreate = byId("btn-open-create");
  if(openCreate) openCreate.addEventListener("click", ()=> openPopup("pop-create","card-create"));

  const openAccent = byId("btn-open-accent");
  if(openAccent) openAccent.addEventListener("click", ()=> openPopup("pop-accent","card-accent"));

  qsa("[data-close-popup]").forEach((b)=> b.addEventListener("click", closePopups));

  // auth
  const logoutBtn = byId("btn-logout");
  if(logoutBtn) logoutBtn.addEventListener("click", ()=> {
    localStorage.removeItem("tt_user");
    location.reload();
  });

  const deleteProfile = byId("btn-delete-profile");
  if(deleteProfile) deleteProfile.addEventListener("click", async ()=> {
    if(!currentUser) return;
    showConfirm("Supprimer définitivement le profil et les contacts liés ?", async ()=> {
      try {
        await deleteDoc(doc(db,"users", currentUser));
        // delete contacts where owner==currentUser or name==currentUser
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
        console.error("deleteProfile error", e);
        showMessage("Erreur lors de la suppression du profil.");
      }
    });
  });

  // auth form hooks (these elements exist in your HTML)
  const loginBtn = byId("btn-login");
  if(loginBtn) loginBtn.addEventListener("click", handleLogin);
  const authCode = byId("auth-code");
  if(authCode) authCode.addEventListener("keydown", (e)=> { if(e.key==="Enter") handleLogin(); });
  const authToggle = byId("auth-toggle");
  if(authToggle) authToggle.addEventListener("click", ()=> { authMode = authMode==="login" ? "register" : "login"; updateAuthUI(); });

  // rooms
  const doCreate = byId("btn-do-create");
  if(doCreate) doCreate.addEventListener("click", createRoom);
  const roomsSearch = byId("rooms-search");
  if(roomsSearch) roomsSearch.addEventListener("input", debounce(()=> renderRoomsTiles(), 180));

  // send message / attach
  const sendBtn = byId("send-btn");
  if(sendBtn) sendBtn.addEventListener("click", ()=> {
    const txt = byId("chat-input").value;
    sendMessageEncrypted(txt);
    byId("chat-input").value = "";
  });
  const chatInput = byId("chat-input");
  if(chatInput) chatInput.addEventListener("keydown", (e)=> { if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendMessageEncrypted(chatInput.value); chatInput.value=""; } });

  const attachBtn = byId("btn-attach");
  if(attachBtn) attachBtn.addEventListener("click", ()=> byId("file-input").click());
  const fileInput = byId("file-input");
  if(fileInput) fileInput.addEventListener("change", (e)=> {
    const file = e.target.files[0];
    if(file) sendImageEncrypted(file);
    e.target.value="";
  });

  // wallpaper controls
  const wallpaperBtn = byId("btn-wallpaper");
  if(wallpaperBtn) wallpaperBtn.addEventListener("click", ()=> byId("bg-file-input").click());
  const bgFileInput = byId("bg-file-input");
  if(bgFileInput) bgFileInput.addEventListener("change", async (e)=> {
    const file = e.target.files[0];
    if(file) await setBackgroundForCurrentChat(file);
    e.target.value="";
  });
  const resetBgBtn = byId("btn-reset-wallpaper");
  if(resetBgBtn) resetBgBtn.addEventListener("click", resetBackgroundForCurrentChat);

  // contacts
  const addContactBtn = byId("btn-add-contact");
  if(addContactBtn) addContactBtn.addEventListener("click", addContact);
  const contactInput = byId("contact-name-input");
  if(contactInput) contactInput.addEventListener("input", debounce(async (e)=>{
    const val = e.target.value.trim().toLowerCase();
    const suggestions = await suggestUsers(val);
    renderSuggestions(suggestions);
  }, 200));
  const contactsSearch = byId("contacts-search");
  if(contactsSearch) contactsSearch.addEventListener("input", debounce(()=> renderContactsTiles(), 180));

  // popup confirm handlers
  const msgOk = byId("msg-ok-btn");
  if(msgOk) msgOk.addEventListener("click", closePopups);
  const confirmYes = byId("confirm-yes");
  if(confirmYes) confirmYes.addEventListener("click", ()=> { if(confirmCallback) confirmCallback(); confirmCallback=null; closePopups(); });
  const confirmNo = byId("confirm-no");
  if(confirmNo) confirmNo.addEventListener("click", ()=> { confirmCallback=null; closePopups(); });

  // accent UI (if present)
  try { initAccent(); } catch(e){ /* optional */ }
  try { updateAuthUI(); } catch(e){ /* optional */ }
}

/* ============================================================
   SUGGESTIONS RENDER
============================================================ */

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

/* ============================================================
   INIT APP
============================================================ */

async function initApp(){
  initUI();
  await ensureGeneralRoom();

  setupRoomsSnapshot();
  setupContactsSnapshot();
  setupMessagesSummarySnapshot();

  // start message listener only when entering a room
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
   SWITCH TAB
============================================================ */

function switchTab(tab){
  const appRoot = byId("main-app");
  if(appRoot) appRoot.classList.add("view-blur");

  qsa(".nav-btn").forEach(b=>b.classList.remove("active"));
  const btn = qsa(".nav-btn").find(b=>b.dataset.tab===tab);
  if(btn) btn.classList.add("active");

  setTimeout(()=> {
    qsa(".view-section").forEach(s=>s.classList.remove("active"));
    const view = byId("view-"+tab);
    if(view) view.classList.add("active");

    const wallpaperBtn = byId("btn-wallpaper");
    if(wallpaperBtn) wallpaperBtn.style.display = (tab === "chat") ? "block" : "none";

    if(appRoot) appRoot.classList.remove("view-blur");

    if(tab==="chat"){
      qsa(".msg-block").forEach((m,i)=>{ m.classList.remove("visible"); setTimeout(()=> m.classList.add("visible"), i*40); });
    }
  }, 220);
}

/* ============================================================
   CLEANUP
============================================================ */

addEventListener("beforeunload", ()=> { if(unsubChat) unsubChat(); });

/* ============================================================
   EXPORT / HOOKS
============================================================ */

window.enterRoom = enterRoom;
window.setBackgroundForCurrentChat = setBackgroundForCurrentChat;
window.loadChatBackground = loadChatBackground;
window.resetBackgroundForCurrentChat = resetBackgroundForCurrentChat;
window.initApp = initApp;
window.setupMessagesSummarySnapshot = setupMessagesSummarySnapshot;

/* ============================================================
   START
============================================================ */

initApp();

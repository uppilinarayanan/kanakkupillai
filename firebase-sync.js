// This file talks to Firebase/Firestore so the app shows the same data on every device
// it's installed on. It's loaded as an ES module (see the type="module" script tag in
// index.html) so it can use Firebase's modern SDK directly from the CDN, no build step.
//
// Everything here is designed to fail quietly: if there's no internet connection, or
// Firebase is briefly unreachable, the functions below just log a warning and do
// nothing further. The rest of the app (app.js) always works entirely from localStorage
// first — this file only ever supplements that, never blocks it.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyAsL5lLPjDxS8_7KHNfIs-D1M0LHneRf7Y",
  authDomain: "kanakkupillai-ee92e.firebaseapp.com",
  projectId: "kanakkupillai-ee92e",
  storageBucket: "kanakkupillai-ee92e.firebasestorage.app",
  messagingSenderId: "1015232850457",
  appId: "1:1015232850457:web:5a932aa0c3710ae3db5888"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Path shape: kanakkupillai (collection) / main (document) / transactions (subcollection)
//                                                            / meta (subcollection)
const txnCollection = collection(db, 'kanakkupillai', 'main', 'transactions');
const metaDoc = (name) => doc(db, 'kanakkupillai', 'main', 'meta', name);

async function pushTransaction(txn) {
  try {
    await setDoc(doc(txnCollection, txn.id), txn);
  } catch (err) {
    console.warn('[sync] could not push transaction, will retry on next sync', err);
  }
}

async function pushMeta(budgets, categories) {
  try {
    await setDoc(metaDoc('budgets'), budgets || {});
    await setDoc(metaDoc('categories'), categories || {});
  } catch (err) {
    console.warn('[sync] could not push settings, will retry on next sync', err);
  }
}

// Full two-way merge, called once when the app loads. Takes whatever is currently in
// localStorage, reconciles it against whatever is in Firestore, and returns the merged
// result for app.js to save back to localStorage and re-render from. Returns null if
// the sync couldn't complete (e.g. no connection) — the caller keeps the local data as-is.
async function syncAll(local) {
  try {
    // --- Transactions: union of both sides, newest updatedAt per id wins ---
    const snapshot = await getDocs(txnCollection);
    const remoteById = new Map();
    snapshot.forEach(d => remoteById.set(d.id, d.data()));

    const localById = new Map(local.expenses.map(t => [t.id, t]));
    const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

    const merged = [];
    const batch = writeBatch(db);
    let pendingWrites = 0;

    allIds.forEach(id => {
      const l = localById.get(id);
      const r = remoteById.get(id);
      let winner;
      if (l && r) winner = (r.updatedAt || 0) > (l.updatedAt || 0) ? r : l;
      else winner = l || r;
      merged.push(winner);

      // Push the winner back to Firestore if Firestore doesn't already have this exact version
      if (!r || (winner.updatedAt || 0) > (r.updatedAt || 0)) {
        batch.set(doc(txnCollection, id), winner);
        pendingWrites++;
      }
    });
    if (pendingWrites > 0) await batch.commit();

    // --- Budgets & categories: whole-document, newest updatedAt wins ---
    const [budgetsSnap, categoriesSnap] = await Promise.all([getDoc(metaDoc('budgets')), getDoc(metaDoc('categories'))]);

    let finalBudgets = local.budgets || {};
    if (budgetsSnap.exists() && (budgetsSnap.data().updatedAt || 0) > (local.budgets?.updatedAt || 0)) {
      finalBudgets = budgetsSnap.data();
    }
    let finalCategories = local.categories || {};
    if (categoriesSnap.exists() && (categoriesSnap.data().updatedAt || 0) > (local.categories?.updatedAt || 0)) {
      finalCategories = categoriesSnap.data();
    }
    await Promise.all([setDoc(metaDoc('budgets'), finalBudgets), setDoc(metaDoc('categories'), finalCategories)]);

    return {
      expenses: merged.filter(t => !t.deleted),
      budgets: finalBudgets,
      categories: finalCategories
    };
  } catch (err) {
    console.warn('[sync] full sync failed, staying on local data for now', err);
    return null;
  }
}

window.firebaseSync = { pushTransaction, pushMeta, syncAll };

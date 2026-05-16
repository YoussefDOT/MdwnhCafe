// Firebase configuration
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, onValue, update, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBUxJmhqzUuhRWS5jL-87IRzhBvzDc5OHQ",
  authDomain: "mdwnh-digital-s.firebaseapp.com",
  databaseURL: "https://mdwnh-digital-s-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "mdwnh-digital-s",
  storageBucket: "mdwnh-digital-s.firebasestorage.app",
  messagingSenderId: "581682259149",
  appId: "1:581682259149:web:95498ed08d5f6ca01b3584",
  measurementId: "G-00F3S4CJZ6"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

export { database, ref, onValue, update, get };

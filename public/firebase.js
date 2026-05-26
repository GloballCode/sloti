// Import the Firebase app SDK directly from the browser-compatible CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDM8-q4bxS_5ZTM9k0xYt123ziJe0-Upzg",
  authDomain: "slotiapp.firebaseapp.com",
  projectId: "slotiapp",
  storageBucket: "slotiapp.firebasestorage.app",
  messagingSenderId: "255112940906",
  appId: "1:255112940906:web:d4da2ae6ebc4e604386913"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
/* ===== FMC Bank: Auth Page Scripts ===== */

// Toggle password visibility
function togglePassword(inputId, iconEl) {
  const input = document.getElementById(inputId);
  const icon = iconEl.querySelector("i");
  if (input.type === "password") {
    input.type = "text";
    icon.classList.remove("fa-eye");
    icon.classList.add("fa-eye-slash");
  } else {
    input.type = "password";
    icon.classList.remove("fa-eye-slash");
    icon.classList.add("fa-eye");
  }
}

// Login form validation
document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const email = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value.trim();

      if (!email || !password) {
        alert("Please enter both email and password.");
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        alert("Please enter a valid email address.");
        return;
      }
      if (password.length < 6) {
        alert("Password must be at least 6 characters.");
        return;
      }
      // ✅ For now: mock success — will be replaced with backend later
      alert(`Welcome back to FMC Bank, ${email}!\n(Backend integration pending.)`);
      // window.location.href = "dashboard.html"; // Uncomment once backend exists
    });
  }

   // Register form validation
  const registerForm = document.getElementById("register-form");
  if (registerForm) {
    registerForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const first = document.getElementById("first-name").value.trim();
      const last = document.getElementById("last-name").value.trim();
      const email = document.getElementById("reg-email").value.trim();
      const phone = document.getElementById("phone").value.trim();
      const pwd = document.getElementById("reg-password").value;
      const confirm = document.getElementById("confirm-password").value;
      const terms = registerForm.querySelector('input[type="checkbox"]').checked;

      if (!first || !last) return alert("Please enter your full name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return alert("Invalid email address.");
      if (!/^\+?[\d\s-]{7,15}$/.test(phone)) return alert("Invalid phone number.");
      if (pwd.length < 8) return alert("Password must be at least 8 characters.");
      if (pwd !== confirm) return alert("Passwords do not match.");
      if (!terms) return alert("Please accept the Terms & Conditions.");

      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            firstName: first, lastName: last, email: email, phone: phone, password: pwd
          })
        });
        const data = await res.json();

        if (res.ok) {
          alert(`✅ Account created successfully!\n\nYour Account Number is: ${data.accountNumber}\n\nYou can now log in.`);
          window.location.href = "login.html";
        } else {
          alert("❌ " + data.error);
        }
      } catch (err) {
        alert("Server error. Is the backend running?");
      }
    });
  }
});
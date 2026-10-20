
    // Load all users
        // ===== ANALYTICS =====
    let monthlyChartInstance = null;

    async function loadAnalytics() {
      try {
        const res = await fetch('/api/admin/analytics');
        if (!res.ok) return;
        const data = await res.json();

        // 1. Stat cards
        const totalDep = data.monthly.reduce((s, m) => s + m.deposits, 0);
        const totalWit = data.monthly.reduce((s, m) => s + m.withdrawals, 0);
        document.getElementById('statDeposits').textContent = '$' + totalDep.toFixed(2);
        document.getElementById('statWithdrawals').textContent = '$' + totalWit.toFixed(2);

        // 2. Monthly chart
        renderMonthlyChart(data.monthly);

        // 3. Top users
        renderTopUsers(data.topUsers);

        // 4. Recent activity
        renderRecentActivity(data.recent);

      } catch (err) {
        console.error("Analytics error:", err);
      }
    }

    function renderMonthlyChart(monthly) {
      const ctx = document.getElementById('monthlyChart').getContext('2d');
      
      // Ensure we always show the last 6 months even if no data
      const months = [];
      const deposits = [];
      const withdrawals = [];
      
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        const key = d.toISOString().substring(0, 7); // "2025-10"
        const label = d.toLocaleString('en-US', { month: 'short', year: '2-digit' });
        
        const found = monthly.find(m => m.month === key);
        months.push(label);
        deposits.push(found ? found.deposits : 0);
        withdrawals.push(found ? found.withdrawals : 0);
      }

      if (monthlyChartInstance) monthlyChartInstance.destroy();

      monthlyChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: months,
          datasets: [
            { label: 'Deposits', data: deposits, backgroundColor: '#28a745', borderRadius: 5 },
            { label: 'Withdrawals', data: withdrawals, backgroundColor: '#dc3545', borderRadius: 5 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top' },
            tooltip: {
              callbacks: {
                label: (ctx) => ctx.dataset.label + ': $' + ctx.parsed.y.toFixed(2)
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: (v) => '$' + v }
            }
          }
        }
      });
    }

    function renderTopUsers(users) {
      const ul = document.getElementById('topUsersList');
      if (!users || users.length === 0) {
        ul.innerHTML = '<li style="color:#999;">No user activity yet.</li>';
        return;
      }
      
      ul.innerHTML = users.map((u, i) => {
        const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
        return `
          <li>
            <div class="rank-badge ${rankClass}">${i + 1}</div>
            <div class="top-user-info">
              <strong>${u.first_name} ${u.last_name}</strong>
              <small>${u.account_number} · $${u.balance.toFixed(2)}</small>
            </div>
            <div class="txn-count">${u.txn_count} txn${u.txn_count !== 1 ? 's' : ''}</div>
          </li>
        `;
      }).join('');
    }

    function renderRecentActivity(recent) {
      const tbody = document.getElementById('recentActivityBody');
      if (!recent || recent.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No activity yet.</td></tr>';
        return;
      }

      tbody.innerHTML = recent.map(t => {
        const date = new Date(t.created_at).toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        return `
          <tr>
            <td style="font-size:12px; color:#888;">${date}</td>
            <td><strong>${t.first_name} ${t.last_name}</strong><br><small style="color:#999;">${t.account_number}</small></td>
            <td><span class="recent-type ${t.type}">${t.type}</span></td>
            <td class="${t.type === 'deposit' ? 'balance' : ''}" style="color:${t.type === 'deposit' ? '#28a745' : '#dc3545'}; font-weight:bold;">
              ${t.type === 'deposit' ? '+' : '-'}$${t.amount.toFixed(2)}
            </td>
            <td style="font-size:13px; color:#555;">${t.description || '-'}</td>
          </tr>
        `;
      }).join('');
    }
    async function loadUsers() {
      try {
        const res = await fetch('/api/admin/users');
        if (res.status === 403 || res.status === 401) {
          window.location.href = 'login.html';
          return;
        }
        const users = await res.json();
        const tbody = document.getElementById('userTableBody');
        tbody.innerHTML = '';

        let totalBalance = 0;
        let userCount = 0;

        users.forEach(user => {
          if (user.role === 'admin') return;
          userCount++;
          totalBalance += user.balance;

          tbody.innerHTML += `
            <tr>
              <td><strong>${user.account_number}</strong></td>
              <td>${user.first_name} ${user.last_name}</td>
              <td>${user.email}</td>
              <td>${user.phone || '-'}</td>
              <td class="balance">$${user.balance.toFixed(2)}</td>
              <td>
                <button class="btn btn-primary btn-sm" onclick="openBalanceModal(${user.id}, '${user.first_name} ${user.last_name}')">
                  Update Balance
                </button>
              </td>
            </tr>
          `;
        });

        if (userCount === 0) {
          tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No users yet. Click "Add New User" to start.</td></tr>';
        }

        document.getElementById('statUsers').textContent = userCount;
        document.getElementById('statBalance').textContent = '$' + totalBalance.toFixed(2);

      } catch (err) {
        console.error(err);
        document.getElementById('userTableBody').innerHTML = 
          '<tr class="empty-row"><td colspan="6">Error loading users. Is the server running?</td></tr>';
      }
    }

    // Add user
    document.getElementById('addUserForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {
        firstName: document.getElementById('fName').value,
        lastName: document.getElementById('lName').value,
        email: document.getElementById('uEmail').value,
        phone: document.getElementById('uPhone').value,
        initialBalance: parseFloat(document.getElementById('uBalance').value) || 0
      };

      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const result = await res.json();
      if (res.ok) {
        alert(`✅ User created!\n\nAccount Number: ${result.accountNumber}\nDefault Password: fmc12345`);
        closeModal('addUserModal');
        document.getElementById('addUserForm').reset();
        loadUsers();
      } else {
        alert('❌ ' + result.error);
      }
    });

    // Open balance modal
    function openBalanceModal(userId, name) {
      document.getElementById('balanceUserId').value = userId;
      document.getElementById('balanceUserName').innerText = `Updating: ${name}`;
      openModal('balanceModal');
    }

    // Process balance change
    document.getElementById('balanceForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {
        userId: document.getElementById('balanceUserId').value,
        type: document.getElementById('transactionType').value,
        amount: parseFloat(document.getElementById('transactionAmount').value),
        description: document.getElementById('transactionDesc').value
      };

      const res = await fetch('/api/admin/balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const result = await res.json();
      if (res.ok) {
        alert(`✅ Success! New Balance: $${result.newBalance.toFixed(2)}`);
        closeModal('balanceModal');
        document.getElementById('balanceForm').reset();
        loadUsers();
      } else {
        alert('❌ ' + result.error);
      }
    });

    // Utilities
    function openModal(id) { document.getElementById(id).classList.add('active'); }
    function closeModal(id) { document.getElementById(id).classList.remove('active'); }

    async function logout() {
      await fetch('/api/logout', { method: 'POST' });
      window.location.href = 'login.html';
    }

    // Close modal when clicking outside
    window.onclick = function(event) {
      document.querySelectorAll('.modal').forEach(m => {
        if (event.target === m) m.classList.remove('active');
      });
    };

    loadUsers();
    loadAnalytics();

# Concierge prompt — provision an always-on server for Box

**Paste everything below into a computer-use agent.**

---

You are helping me rent a small, always-on Linux server (VPS) to host an app called "Box".
Drive the browser; I'll handle my own logins and approve anything that costs money.

**Rules:**
- I will type my own passwords/payment into the real provider pages. Never ask me to paste a
  long-term password to you. Pause and get my explicit "yes" before any charge.
- Pick the **cheapest plan that fits** — this is a personal app. ~$5–6/month is plenty.
- When done, give me a short summary with the server's **public IP**, the **SSH command** to
  connect, and the **monthly cost**.

**Steps:**
1. Recommend one beginner-friendly provider (e.g. DigitalOcean, Hetzner, Vultr, or Linode).
   Ask me which I'd like, or pick the cheapest reputable one and tell me why.
2. Help me sign in or create an account (I'll do the actual auth). Stop for my OK before the
   account incurs any cost.
3. Create the smallest reasonable instance:
   - **OS:** Ubuntu 22.04 or 24.04 LTS.
   - **Size:** the cheapest with **≥1 GB RAM** (2 GB is safer for builds). 1 vCPU is fine.
   - **Region:** closest to me.
   - **Auth:** SSH key if I have one; otherwise let it set a root password and show me how to
     copy it. Prefer adding my SSH public key if I can provide one.
4. After it boots, give me:
   - the **public IPv4 address**,
   - the exact **`ssh` command** to connect (e.g. `ssh root@<ip>`),
   - confirmation the firewall allows outbound HTTPS (Box needs no inbound ports — it uses a
     Cloudflare tunnel — so you do NOT need to open port 7321).
5. Tell me my next step in plain words: *"SSH into the server, then run:
   `git clone <box repo> && cd box && curl -fsSL https://claude.ai/install.sh | bash` (or
   install Node + the claude CLI), log into `claude`, then `claude` and say 'install this'."*

Do not install anything on the server yourself unless I ask — just get me the box and the SSH
access. Summarize cost and access clearly at the end.

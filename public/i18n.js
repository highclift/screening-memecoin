// Every piece of UI text lives here, in both languages. Nothing else in public/ may hard-code
// a user-visible sentence: add a key instead. Loaded before the other scripts.
//
// t("key", { name: "FOO" }) looks the key up in the active language and fills {placeholders}.
// Static markup is translated through data-i18n attributes (see applyStaticText).

const LANG_STORAGE_KEY = "launchpad.lang";
const LANG_DEFAULT = "id";
const LANG_SUPPORTED = ["id", "en"];

const I18N = {
  id: {
    "lang.switchLabel": "Bahasa",
    "lang.id": "Indonesia",
    "lang.en": "English",

    // ---------- chrome ----------
    "nav.overview": "Ringkasan",
    "nav.bots": "Bot",
    "nav.strategy": "Strategi",
    "nav.activity": "Aktivitas",
    "side.caption": "TERMINAL PAPER",
    "side.paperChip": "MODE LATIHAN",
    "side.paperNote": "Hanya simulasi.<br />Tidak ada transaksi on-chain.",
    "side.docs": "Dokumentasi feed",
    "top.eyebrow": "SOLANA · FEED PUMP.FUN",
    "top.title": "Pemantau token AMM",
    "top.subtitle": "Tiga bot berlatih bersama di satu halaman: yang baru lahir, yang berumur jam, dan yang berumur hari.",
    "feed.connected": "Feed terhubung",
    "feed.connecting": "Menghubungkan feed",
    "feed.disconnected": "Feed terputus",
    "button.stop": "Hentikan bot",

    "hero.label": "LINGKUNGAN LATIHAN",
    "hero.labelRight": "TANPA TANDA TANGAN WALLET",
    "hero.title1": "Uji strategimu",
    "hero.title2": "sebelum masuk pasar.",
    "hero.body": "Bot menonton koin baru, menunggu harganya turun lalu memantul, dan mencatat beli/jual palsu. Uangnya tidak nyata, jadi kesalahan di sini gratis.",
    "hero.runtimeLabel": "STATUS BOT",
    "hero.mode": "Mode",
    "hero.modeValue": "Latihan saja",
    "hero.pair": "Pasangan",
    "hero.pairValue": "SOL / token AMM",

    "runtime.stopped": "Siap dijalankan",
    "runtime.starting": "Sedang menyala…",
    "runtime.running": "Bot aktif",
    "runtime.stopping": "Sedang berhenti…",
    "runtime.error": "Perlu diperiksa",
    "runtime.detail.running": "Menunggu koin yang cocok dengan aturanmu. Saldo tetap latihan.",
    "runtime.detail.connecting": "Menyambung ke sumber data.",
    "runtime.detail.hasKey": "API key tersedia; atur strategi lalu tekan Mulai.",
    "runtime.detail.noKey": "API key tidak wajib di mode gratis; tekan Mulai.",

    // ---------- "what is happening" headline ----------
    "now.eyebrow": "SEDANG TERJADI",
    "now.title": "Apa yang bot lakukan sekarang",
    "now.stopped": "Bot belum berjalan. Tekan “Mulai paper scanner” di bawah dan halaman ini akan menjelaskan setiap langkahnya.",
    "now.starting": "Bot sedang dinyalakan. Sebentar lagi mulai mencari koin.",
    "now.stopping": "Bot sedang dimatikan.",
    "now.error": "Bot berhenti karena ada masalah. Penjelasannya ada di kartu merah di bawah.",
    "now.connecting": "Bot menyala, tapi belum tersambung ke sumber data koin. Biasanya ini selesai sendiri dalam beberapa detik.",
    "now.idle": "Bot sedang menunggu koin baru muncul. Belum ada yang perlu dinilai.",
    "now.watching": "Bot sedang mengawasi {coins} dan menunggu salah satunya memenuhi syarat beli.",
    "now.holding": "Bot sedang memegang {positions} dan menunggu waktu yang tepat untuk menjual.",
    "now.watchingHolding": "Bot memegang {positions} dan masih mengawasi {coins} lain.",
    "frag.coins": "{n} koin",
    "frag.positions": "{n} posisi latihan",
    "now.hintTechnical": "Detail teknis",

    // ---------- metrics ----------
    "metric.balance": "Saldo latihan",
    "metric.balanceFoot": "SOL yang bisa dipakai beli",
    "metric.pnl": "Untung/rugi hari ini",
    "metric.pnlFoot": "Sudah termasuk fee dan slippage simulasi",
    "metric.positions": "Posisi terbuka",
    "metric.positionsFoot": "Batas bersamaan {limit}",
    "metric.entries": "Pembelian hari ini",
    "metric.entriesFoot": "Batas harian {limit}",

    // ---------- lane cards ----------
    "lanes.eyebrow": "TIGA BOT",
    "lanes.title": "Bot dan tugasnya",
    "lanes.note": "Masing-masing punya saldo dan aturan sendiri",
    "lane.fresh.name": "Bot Koin Baru",
    "lane.fresh.task": "Menangkap koin pada menit-menit pertama setelah pindah ke pool AMM.",
    "lane.fresh.age": "umur beberapa menit",
    "lane.young.name": "Bot Koin Muda",
    "lane.young.task": "Mencari koin yang sudah hidup 1 sampai 24 jam dan masih ramai.",
    "lane.young.age": "umur 1–24 jam",
    "lane.veteran.name": "Bot Koin Mapan",
    "lane.veteran.task": "Mencari koin berumur 1 sampai 30 hari dengan pool yang lebih dalam.",
    "lane.veteran.age": "umur 1–30 hari",
    "lane.off": "Dimatikan",
    "lane.on": "Aktif",
    "lane.offReason": "Bot ini tidak dinyalakan. Tambahkan namanya ke pengaturan LANES di file .env untuk menyalakannya.",
    "lane.balance": "Saldo",
    "lane.pnl": "Untung/rugi",
    "lane.open": "Dipegang",
    "lane.record": "Menang / kalah",
    "lane.watching": "Diawasi",
    "lane.entriesToday": "Beli hari ini",
    "lane.now.off": "Mati — tidak mencari apa pun.",
    "lane.now.notStarted": "Belum dijalankan. Tekan “Mulai paper scanner” untuk menyalakannya.",
    "lane.now.idle": "Belum menemukan koin yang cocok dengan rentang umurnya.",
    "lane.now.watching": "Mengawasi {coins}; paling banyak menunggu: {stage}.",
    "lane.now.holding": "Memegang {positions}.",
    "lane.now.waitingData": "Menunggu data pertama dari sumber koin.",
    "lane.detailsToggle": "Lihat angka lengkap",
    "lane.threshold.marketCap": "Market cap yang dicari",
    "lane.threshold.liquidity": "Likuiditas minimum",
    "lane.threshold.buyers": "Pembeli unik minimum",
    "lane.threshold.pullback": "Turun dulu sebanyak",
    "lane.threshold.bounce": "Lalu memantul",
    "lane.threshold.takeProfit": "Jual untung di",
    "lane.threshold.stopLoss": "Jual rugi di",
    "lane.threshold.buyAmount": "Uang per pembelian",

    // ---------- stages (what a coin is waiting for) ----------
    "stage.blocked": "Tertahan batas risiko",
    "stage.social": "Menunggu data media sosial",
    "stage.data": "Menunggu data harga",
    "stage.trades": "Belum cukup transaksi",
    "stage.buys": "Belum cukup pembelian",
    "stage.buyers": "Belum cukup pembeli berbeda",
    "stage.pullback": "Harga belum turun dari puncak",
    "stage.rebound": "Menunggu harga memantul naik",
    "stage.holders": "Menunggu data pemilik koin",
    "stage.score": "Nilai kelayakan masih rendah",
    "stage.signal": "Siap dibeli; cek batas risiko",
    "stage.unknown": "Sedang dinilai",
    "stage.detail.trades": "{have} dari {need} transaksi",
    "stage.detail.buys": "{have} dari {need} pembelian",
    "stage.detail.buyers": "{have} dari {need} pembeli berbeda",
    "stage.detail.pullback": "menunggu turun {pct}% dari puncak",
    "stage.detail.rebound": "menunggu naik {pct}% dari titik terendah",
    "stage.detail.score": "butuh nilai minimal {need}",

    // ---------- feed (plain language) ----------
    "activity.eyebrow": "SIARAN LANGSUNG",
    "activity.title": "Cerita langkah demi langkah",
    "activity.note": "Bahasa sehari-hari",
    "activity.empty": "Cerita akan muncul di sini begitu bot dijalankan.",
    "activity.technical": "Detail teknis (log asli)",
    "activity.technicalEmpty": "Belum ada log.",

    "ev.start": "Bot dinyalakan dengan saldo latihan {balance} dan {buy} per pembelian.",
    "ev.strategy": "Aturan jual-beli dipasang: tunggu harga turun {pullback}%, lalu memantul {bounce}%.",
    "ev.pipeline": "Urutan pemeriksaan dipasang: riwayat pembuat koin, likuiditas, volume, lalu sebaran pemilik.",
    "ev.lanes": "{lane}: {state}.",
    "ev.laneOn": "aktif dan mencari koin",
    "ev.laneOff": "dimatikan",
    "ev.discovery": "Mulai menyisir koin yang sudah lebih tua lewat GeckoTerminal.",
    "ev.feedConnected": "Tersambung ke sumber data. Bot sekarang bisa melihat koin baru lahir.",
    "ev.feedFree": "Memakai sumber data gratis: harga diambil ulang tiap {seconds} detik.",
    "ev.feedDisconnected": "Sambungan data terputus. Mencoba menyambung lagi dalam {seconds} detik.",
    "ev.feedError": "Sumber data menolak permintaan: {detail}",
    "ev.migration": "Koin baru {token} pindah ke pool AMM dan mulai diawasi.",
    "ev.candidate": "{token} masuk daftar awasan.",
    "ev.skip": "{token} dilewati: {reason}",
    "ev.skipCapacity": "{token} dilewati karena daftar awasan sudah penuh ({limit} koin).",
    "ev.expire": "Waktu habis untuk {token}; sampai akhir ia masih {stage}. Tidak dibeli.",
    "ev.expireSimple": "Waktu pengawasan {token} habis tanpa sinyal beli. Tidak dibeli.",
    "ev.buy": "Beli latihan {token}: {spend} keluar pada market cap {mc}, setelah {trades} transaksi dari {buyers} pembeli berbeda.",
    "ev.exit.takeProfit": "Jual {token} karena target untung tercapai: {pnl}.",
    "ev.exit.stopLoss": "Jual {token} karena menyentuh batas rugi: {pnl}.",
    "ev.exit.maxHold": "Jual {token} karena sudah dipegang terlalu lama: {pnl}.",
    "ev.exit.stale": "Jual {token} karena harganya tidak terbaca lagi: {pnl}.",
    "ev.exit.other": "Jual {token}: {pnl}.",
    "ev.stale": "Harga {token} berhenti terbaca; posisi ditutup di harga terakhir yang diketahui.",
    "ev.startRequested": "Menyalakan bot latihan…",
    "ev.stopRequested": "Permintaan berhenti diterima.",
    "ev.stopped": "Bot sudah berhenti.",
    "ev.workerStarted": "Mesin bot berjalan.",
    "ev.workerError": "Mesin bot bermasalah: {detail}",
    "ev.workerCrashed": "Bot berhenti karena error. Buka “Detail teknis” di bawah untuk melihat penyebabnya.",
    "ev.startError": "Bot gagal dinyalakan: {detail}",
    "ev.settingsApplied": "Perubahan strategi dikirim ke bot yang sedang jalan.",
    "ev.settingsError": "Perubahan strategi ditolak: {detail}",
    "ev.resetAccount": "Saldo latihan direset ke {balance}.",
    "ev.dashboardReady": "Dashboard siap.",
    "ev.subscriptions": "Berlangganan data transaksi untuk {count} koin.",

    // reasons a coin is skipped
    "reason.market_cap": "ukurannya di luar rentang yang kamu minta",
    "reason.dev_history": "pembuatnya pernah meluncurkan koin yang harganya hancur",
    "reason.liquidity": "uang di pool-nya terlalu sedikit untuk keluar dengan aman",
    "reason.volume": "perdagangan satu jam terakhir terlalu sepi",
    "reason.holders": "beberapa dompet memegang terlalu banyak koin ini",
    "reason.social": "tidak punya tautan media sosial yang kamu syaratkan",
    "reason.capacity": "daftar awasan sudah penuh",
    "reason.unknown": "tidak memenuhi salah satu syarat",

    // ---------- screener / funnel ----------
    "screener.eyebrow": "DAFTAR AWASAN",
    "screener.title": "Koin yang sedang dinilai",
    "screener.stopped": "BOT BERHENTI",
    "screener.starting": "SEDANG MENYALA",
    "screener.stopping": "SEDANG BERHENTI",
    "screener.error": "BOT ERROR",
    "screener.waitingFeed": "MENUNGGU SAMBUNGAN",
    "screener.live": "AKTIF · MENCARI KOIN",
    "screener.updateServer": "SERVER PERLU RESTART",
    "screener.countMiddle": "koin dinilai dari",
    "screener.found": "Koin ditemukan",
    "screener.filtered": "Tidak lolos saringan",
    "screener.entered": "Dibeli (latihan)",
    "screener.expiredStat": "Kehabisan waktu",
    "screener.candidates": "Daftar awasan",
    "screener.candidatesNote": "40 terbaru",
    "screener.empty": "Belum ada koin di daftar awasan.",
    "screener.emptyActive": "Koin sedang diawasi; detailnya muncul begitu ada transaksi.",
    "th.token": "Koin",
    "th.waitingFor": "Sedang menunggu",
    "th.bot": "Bot",
    "th.activity": "Transaksi / beli / pembeli",
    "th.marketCap": "Market cap USD",
    "th.age": "Umur",

    "funnel.title": "Mengapa koin gugur",
    "funnel.note": "sejak bot dijalankan",
    "funnel.empty": "Belum ada koin yang gugur.",
    "funnel.scored": "Dinilai lengkap",
    "funnel.scoreBlocked": "Ditahan karena nilai",
    "funnel.devUnknown": "Pembuat tanpa data",
    "funnel.holderCheck": "Cek pemilik koin",
    "funnel.on": "Aktif",
    "funnel.off": "Mati",
    "funnel.share": "{pct}% dari yang ditemukan",
    "funnel.market_cap": "Ukuran di luar rentang",
    "funnel.capacity": "Daftar awasan penuh",
    "funnel.dev_history": "Riwayat pembuat buruk",
    "funnel.social": "Tautan sosial kurang",
    "funnel.liquidity": "Likuiditas terlalu kecil",
    "funnel.volume": "Volume satu jam terlalu sepi",
    "funnel.holders": "Pemilik terlalu terpusat",
    "funnel.expired": "Kehabisan waktu: {stage}",

    // ---------- positions / trades ----------
    "positions.eyebrow": "LATIHAN",
    "positions.title": "Koin yang dipegang sekarang",
    "positions.empty": "Belum ada koin yang dipegang.",
    "positions.cost": "{cost} · masuk di {entry} · sekarang {now}",
    "trades.eyebrow": "RIWAYAT",
    "trades.title": "Jual-beli terakhir",
    "trades.note": "20 terakhir",
    "trades.empty": "Belum ada jual-beli yang selesai.",
    "th.entryMc": "MC saat beli",
    "th.exitMc": "MC saat jual",
    "th.reason": "Alasan jual",
    "th.pnl": "Untung/rugi",
    "trade.openedAt": "beli {time}",
    "trade.closedAt": "jual {time}",
    "trade.held": "dipegang {duration}",
    "exit.take-profit": "Target untung",
    "exit.stop-loss": "Batas rugi",
    "exit.max-hold": "Waktu habis",
    "exit.max-hold-stale": "Harga hilang",
    "exit.exit": "Keluar",

    // ---------- start diagnostics ----------
    "startup.eyebrow": "KESIAPAN",
    "startup.ready": "Siap dijalankan",
    "startup.readyBadge": "SIAP",
    "startup.readyMessage": "API key tidak wajib di mode gratis. Tekan “Mulai paper scanner”.",
    "startup.startingTitle": "Bot sedang menyala",
    "startup.startingBadge": "MENYALA",
    "startup.startingMessage": "Permintaan diterima; menunggu mesin bot dan sambungan data.",
    "startup.stoppingTitle": "Bot sedang berhenti",
    "startup.stoppingBadge": "BERHENTI",
    "startup.stoppingMessage": "Menunggu proses bot selesai.",
    "startup.errorTitle": "Gagal dinyalakan",
    "startup.errorBadge": "ERROR",
    "startup.errorMessage": "Server melaporkan error tetapi belum mengirim detailnya.",
    "startup.liveTitle": "Tersambung ke sumber data",
    "startup.liveBadge": "AKTIF",
    "startup.liveMessage": "Sambungan aktif; menunggu koin baru pindah ke pool AMM.",
    "startup.feedTitle": "Bot jalan, data belum tersambung",
    "startup.feedBadge": "DATA",
    "startup.feedMessage": "Menunggu sambungan. Kalau terus begini, periksa API key dan log teknis di bawah.",
    "startup.tradeMissingTitle": "Koin masuk, transaksi belum terbaca",
    "startup.tradeMissingBadge": "CEK DATA",
    "startup.tradeMissingMessage": "Sambungan aktif, tapi koin yang diawasi masih 0 transaksi. Di mode gratis, tunggu beberapa detik karena DexScreener perlu mengindeks pool baru.",
    "startup.uiErrorTitle": "Dashboard gagal memuat data",
    "startup.uiErrorBadge": "ERROR UI",
    "startup.eventsEmpty": "Belum ada percobaan menyalakan bot.",
    "startup.serverStale": "Server yang berjalan belum memuat diagnosa terbaru. Hentikan proses npm start sekali, jalankan lagi, lalu muat ulang halaman.",

    // ---------- form ----------
    "form.eyebrow": "PENGATURAN",
    "form.title": "Atur strategi",
    "form.tag": "LATIHAN",
    "form.sourceTitle": "Sumber data langsung",
    "form.sourceNote": "Koin baru diawasi setelah pindah ke pool AMM. Pembelian tetap menunggu transaksi dan pembeli yang cukup.",
    "form.keyTitle": "PumpPortal API key (opsional)",
    "form.keySub": "Tidak wajib di mode gratis. Hanya dipakai server lokal.",
    "form.keyPlaceholder": "Tempel API key di sini",
    "form.keyHelp": "Belum punya key?",
    "form.keyHelpLink": "Buat di PumpPortal ↗",
    "form.keyNote": "Key bisa memberi akses trading di layanan PumpPortal. Dashboard ini hanya memakainya untuk data latihan dan tidak menyimpannya.",
    "form.sizeTitle": "Ukuran simulasi",
    "form.startBalance": "Saldo awal",
    "form.buyAmount": "Uang per pembelian",
    "form.maxOpen": "Posisi bersamaan",
    "form.maxEntries": "Batas beli per hari",
    "form.sizeNote": "Saldo awal hanya berlaku saat membuat atau mereset akun latihan.",
    "form.filterTitle": "Saringan koin",
    "form.minMc": "Market cap minimum",
    "form.maxMc": "Market cap maksimum",
    "form.minTrades": "Transaksi minimum",
    "form.minBuys": "Pembelian minimum",
    "form.minBuyers": "Pembeli berbeda minimum",
    "form.maxAge": "Umur maksimum kandidat",
    "form.socialMode": "Syarat tautan sosial",
    "form.social.twitter": "Wajib ada X/Twitter",
    "form.social.any": "Minimal satu: X, Telegram, atau situs",
    "form.social.multiple": "Minimal dua jenis tautan",
    "form.social.off": "Tanpa saringan sosial",
    "form.socialNote": "Pilihan dua tautan menghitung X/Twitter, Telegram, dan situs web sebagai jenis berbeda.",
    "form.exitTitle": "Kapan beli dan jual",
    "form.pullback": "Turun dari puncak",
    "form.bounce": "Memantul dari titik rendah",
    "form.takeProfit": "Target untung",
    "form.stopLoss": "Batas rugi",
    "form.maxHold": "Lama maksimum memegang",
    "form.maxDailyLoss": "Batas rugi harian",
    "form.advanced": "Pengaturan lanjutan",
    "form.maxActive": "Isi maksimum daftar awasan",
    "form.fee": "Fee simulasi",
    "form.slippage": "Slippage simulasi",
    "form.start": "Mulai paper scanner",
    "form.apply": "Terapkan sekarang",
    "form.reset": "Reset akun latihan",
    "unit.sol": "SOL",
    "unit.usd": "USD",
    "unit.pct": "%",
    "unit.seconds": "detik",
    "unit.bps": "bps / sisi",

    "msg.starting": "Menyalakan bot latihan…",
    "msg.started": "Bot jalan. Saldo dan jual-beli di halaman ini hanya simulasi.",
    "msg.applying": "Mengirim perubahan ke bot yang sedang jalan…",
    "msg.applied": "Strategi diterapkan tanpa perlu restart.",
    "msg.stopping": "Meminta bot berhenti…",
    "msg.reset": "Akun latihan berhasil direset.",
    "msg.resetConfirm": "Reset saldo dan riwayat latihan ke {balance} SOL? Ini menghapus simulasi yang sekarang.",
    "msg.readError": "Dashboard tidak bisa membaca server: {detail}",

    // ---------- info + footer ----------
    "info.title": "Mode data gratis",
    "info.body": "Koin baru dari PumpPortal (gratis); harga dan jumlah transaksi dari DexScreener; pembeli berbeda dari GeckoTerminal. Tidak perlu saldo SOL.",
    "info.link": "Rincian biaya PumpPortal ↗",
    "footer.note": "Market cap USD dihitung dari harga token dan SOL/USD. Hasil latihan tidak menjamin harga atau hasil sungguhan.",

    // ---------- jargon tooltips ----------
    "help.pullback": "Pullback: harga mundur dari titik tertingginya. Bot menolak membeli saat harga sedang di puncak, karena risiko jatuh lebih besar di sana.",
    "help.rebound": "Rebound atau pantulan: setelah mundur, harga mulai naik lagi. Itu tanda pembeli kembali masuk, dan di situlah bot membeli.",
    "help.score": "Nilai kelayakan 0–1 yang merangkum riwayat pembuat koin, likuiditas, volume, dan sebaran pemilik. Semakin tinggi semakin aman menurut aturanmu.",
    "help.liquidity": "Likuiditas: jumlah uang di dalam pool. Kalau terlalu kecil, menjual sedikit saja sudah menjatuhkan harga.",
    "help.marketCap": "Market cap: harga satu koin dikali jumlah koin yang ada. Ini ukuran kasar seberapa besar koin itu.",
    "help.uniqueBuyers": "Pembeli berbeda: berapa banyak dompet yang membeli, bukan berapa kali pembelian terjadi. Satu orang membeli 50 kali tetap dihitung satu.",
    "help.lane": "Setiap bot punya satu tugas dan satu saldo sendiri, jadi hasilnya bisa dibandingkan: koin baru lahir, koin berumur jam, dan koin berumur hari.",
    "help.paper": "Mode latihan: semua pembelian dan penjualan hanya dicatat di komputer ini. Tidak ada wallet, tidak ada uang sungguhan.",
    "help.devHistory": "Riwayat pembuat: bot mengingat dompet yang pernah meluncurkan koin, dan menolak koin dari pembuat yang koin sebelumnya jatuh.",
    "help.funnel": "Daftar ini menghitung alasan koin gugur. Kalau satu alasan mendominasi, saringan itu mungkin terlalu ketat.",
  },

  en: {
    "lang.switchLabel": "Language",
    "lang.id": "Indonesia",
    "lang.en": "English",

    "nav.overview": "Overview",
    "nav.bots": "Bots",
    "nav.strategy": "Strategy",
    "nav.activity": "Activity",
    "side.caption": "PAPER TERMINAL",
    "side.paperChip": "PRACTICE MODE",
    "side.paperNote": "Simulation only.<br />No on-chain transactions.",
    "side.docs": "Feed documentation",
    "top.eyebrow": "SOLANA · PUMP.FUN FEED",
    "top.title": "AMM token monitor",
    "top.subtitle": "Three bots practising side by side: newborn coins, coins a few hours old, and coins a few days old.",
    "feed.connected": "Feed connected",
    "feed.connecting": "Connecting feed",
    "feed.disconnected": "Feed offline",
    "button.stop": "Stop the bot",

    "hero.label": "PRACTICE ENVIRONMENT",
    "hero.labelRight": "NO WALLET SIGNING",
    "hero.title1": "Test your strategy",
    "hero.title2": "before you risk money.",
    "hero.body": "The bots watch new coins, wait for the price to dip and bounce back, and record pretend buys and sells. The money is not real, so mistakes here are free.",
    "hero.runtimeLabel": "BOT STATUS",
    "hero.mode": "Mode",
    "hero.modeValue": "Practice only",
    "hero.pair": "Pair",
    "hero.pairValue": "SOL / AMM token",

    "runtime.stopped": "Ready to start",
    "runtime.starting": "Starting up…",
    "runtime.running": "Bots running",
    "runtime.stopping": "Shutting down…",
    "runtime.error": "Needs attention",
    "runtime.detail.running": "Waiting for coins that match your rules. The balance stays pretend.",
    "runtime.detail.connecting": "Connecting to the data source.",
    "runtime.detail.hasKey": "API key found; set your strategy and press Start.",
    "runtime.detail.noKey": "An API key is optional in free mode; press Start.",

    "now.eyebrow": "HAPPENING NOW",
    "now.title": "What the bots are doing right now",
    "now.stopped": "The bots are not running yet. Press “Start paper scanner” below and this page will narrate every step.",
    "now.starting": "The bots are starting up. They will begin looking for coins in a moment.",
    "now.stopping": "The bots are shutting down.",
    "now.error": "The bots stopped because something went wrong. The red card below explains it.",
    "now.connecting": "The bots are running but not connected to the coin data source yet. This usually clears itself within seconds.",
    "now.idle": "Waiting for new coins to appear. Nothing to judge yet.",
    "now.watching": "Watching {coins} and waiting for one of them to meet the buy conditions.",
    "now.holding": "Holding {positions} and waiting for the right moment to sell.",
    "now.watchingHolding": "Holding {positions} and still watching {coins}.",
    "frag.coins": "{n} coins",
    "frag.coins.one": "1 coin",
    "frag.positions": "{n} practice positions",
    "frag.positions.one": "1 practice position",
    "now.hintTechnical": "Technical details",

    "metric.balance": "Practice balance",
    "metric.balanceFoot": "SOL available to buy with",
    "metric.pnl": "Profit/loss today",
    "metric.pnlFoot": "Simulated fees and slippage included",
    "metric.positions": "Open positions",
    "metric.positionsFoot": "Limit {limit} at once",
    "metric.entries": "Buys today",
    "metric.entriesFoot": "Daily limit {limit}",

    "lanes.eyebrow": "THREE BOTS",
    "lanes.title": "The bots and their jobs",
    "lanes.note": "Each has its own balance and rules",
    "lane.fresh.name": "New Coin Bot",
    "lane.fresh.task": "Catches coins in their first minutes after moving to an AMM pool.",
    "lane.fresh.age": "minutes old",
    "lane.young.name": "Young Coin Bot",
    "lane.young.task": "Looks for coins that are 1 to 24 hours old and still busy.",
    "lane.young.age": "1–24 hours old",
    "lane.veteran.name": "Established Coin Bot",
    "lane.veteran.task": "Looks for coins 1 to 30 days old with deeper pools.",
    "lane.veteran.age": "1–30 days old",
    "lane.off": "Off",
    "lane.on": "Running",
    "lane.offReason": "This bot is not switched on. Add its name to the LANES setting in your .env file to enable it.",
    "lane.balance": "Balance",
    "lane.pnl": "Profit/loss",
    "lane.open": "Holding",
    "lane.record": "Wins / losses",
    "lane.watching": "Watching",
    "lane.entriesToday": "Buys today",
    "lane.now.off": "Off — not looking for anything.",
    "lane.now.notStarted": "Not started yet. Press “Start paper scanner” to switch it on.",
    "lane.now.idle": "Has not found a coin in its age range yet.",
    "lane.now.watching": "Watching {coins}; most are waiting on: {stage}.",
    "lane.now.holding": "Holding {positions}.",
    "lane.now.waitingData": "Waiting for the first data from the coin source.",
    "lane.detailsToggle": "Show the full numbers",
    "lane.threshold.marketCap": "Market cap it looks for",
    "lane.threshold.liquidity": "Minimum liquidity",
    "lane.threshold.buyers": "Minimum unique buyers",
    "lane.threshold.pullback": "Must dip by",
    "lane.threshold.bounce": "Then bounce by",
    "lane.threshold.takeProfit": "Sell in profit at",
    "lane.threshold.stopLoss": "Sell at a loss at",
    "lane.threshold.buyAmount": "Money per buy",

    "stage.blocked": "Held back by a risk limit",
    "stage.social": "Waiting for social links",
    "stage.data": "Waiting for price data",
    "stage.trades": "Not enough trades yet",
    "stage.buys": "Not enough buys yet",
    "stage.buyers": "Not enough different buyers",
    "stage.pullback": "Price has not dipped from its peak",
    "stage.rebound": "Waiting for the price to bounce back",
    "stage.holders": "Waiting for holder data",
    "stage.score": "Quality score still too low",
    "stage.signal": "Ready to buy; checking risk limits",
    "stage.unknown": "Being judged",
    "stage.detail.trades": "{have} of {need} trades",
    "stage.detail.buys": "{have} of {need} buys",
    "stage.detail.buyers": "{have} of {need} different buyers",
    "stage.detail.pullback": "waiting for a {pct}% dip from the peak",
    "stage.detail.rebound": "waiting for a {pct}% rise off the low",
    "stage.detail.score": "needs a score of at least {need}",

    "activity.eyebrow": "LIVE",
    "activity.title": "Step-by-step story",
    "activity.note": "Everyday language",
    "activity.empty": "The story appears here once the bots are running.",
    "activity.technical": "Technical details (raw log)",
    "activity.technicalEmpty": "No log lines yet.",

    "ev.start": "Bots switched on with a {balance} practice balance and {buy} per buy.",
    "ev.strategy": "Buy/sell rules loaded: wait for a {pullback}% dip, then a {bounce}% bounce.",
    "ev.pipeline": "Check order loaded: creator history, liquidity, volume, then how concentrated the holders are.",
    "ev.lanes": "{lane}: {state}.",
    "ev.laneOn": "running and looking for coins",
    "ev.laneOff": "switched off",
    "ev.discovery": "Started sweeping older coins through GeckoTerminal.",
    "ev.feedConnected": "Connected to the data source. The bots can now see coins as they launch.",
    "ev.feedFree": "Using the free data source: prices refresh every {seconds} seconds.",
    "ev.feedDisconnected": "Data connection dropped. Trying again in {seconds} seconds.",
    "ev.feedError": "The data source rejected a request: {detail}",
    "ev.migration": "New coin {token} moved to an AMM pool and is now being watched.",
    "ev.candidate": "{token} was added to the watchlist.",
    "ev.skip": "Skipped {token}: {reason}",
    "ev.skipCapacity": "Skipped {token} because the watchlist is full ({limit} coins).",
    "ev.expire": "Time ran out for {token}; it was still {stage}. Not bought.",
    "ev.expireSimple": "{token} ran out of watch time without a buy signal. Not bought.",
    "ev.buy": "Practice buy of {token}: {spend} spent at a {mc} market cap, after {trades} trades from {buyers} different buyers.",
    "ev.exit.takeProfit": "Sold {token} because it hit the profit target: {pnl}.",
    "ev.exit.stopLoss": "Sold {token} because it hit the loss limit: {pnl}.",
    "ev.exit.maxHold": "Sold {token} because it was held too long: {pnl}.",
    "ev.exit.stale": "Sold {token} because its price stopped updating: {pnl}.",
    "ev.exit.other": "Sold {token}: {pnl}.",
    "ev.stale": "{token} stopped reporting a price; the position was closed at the last known price.",
    "ev.startRequested": "Starting the practice bots…",
    "ev.stopRequested": "Stop request received.",
    "ev.stopped": "The bots have stopped.",
    "ev.workerStarted": "Bot engine is running.",
    "ev.workerError": "The bot engine hit a problem: {detail}",
    "ev.workerCrashed": "The bots stopped because of an error. Open “Technical details” below to see the cause.",
    "ev.startError": "The bots could not start: {detail}",
    "ev.settingsApplied": "Strategy changes sent to the running bots.",
    "ev.settingsError": "Strategy change rejected: {detail}",
    "ev.resetAccount": "Practice balance reset to {balance}.",
    "ev.dashboardReady": "Dashboard ready.",
    "ev.subscriptions": "Subscribed to trade data for {count} coins.",

    "reason.market_cap": "its size is outside the range you asked for",
    "reason.dev_history": "the same creator has launched coins that collapsed before",
    "reason.liquidity": "there is too little money in its pool to exit safely",
    "reason.volume": "trading in the last hour was too quiet",
    "reason.holders": "a few wallets hold too much of the supply",
    "reason.social": "it has none of the social links you require",
    "reason.capacity": "the watchlist is already full",
    "reason.unknown": "it failed one of the checks",

    "screener.eyebrow": "WATCHLIST",
    "screener.title": "Coins being judged",
    "screener.stopped": "BOTS STOPPED",
    "screener.starting": "STARTING UP",
    "screener.stopping": "SHUTTING DOWN",
    "screener.error": "BOT ERROR",
    "screener.waitingFeed": "WAITING FOR CONNECTION",
    "screener.live": "LIVE · LOOKING FOR COINS",
    "screener.updateServer": "SERVER NEEDS RESTART",
    "screener.countMiddle": "coins being judged out of",
    "screener.found": "Coins found",
    "screener.filtered": "Failed the filters",
    "screener.entered": "Bought (practice)",
    "screener.expiredStat": "Ran out of time",
    "screener.candidates": "Watchlist",
    "screener.candidatesNote": "40 most recent",
    "screener.empty": "No coins on the watchlist yet.",
    "screener.emptyActive": "Coins are being watched; details appear once they trade.",
    "th.token": "Coin",
    "th.waitingFor": "Waiting for",
    "th.bot": "Bot",
    "th.activity": "Trades / buys / buyers",
    "th.marketCap": "Market cap USD",
    "th.age": "Age",

    "funnel.title": "Why coins dropped out",
    "funnel.note": "since the bots started",
    "funnel.empty": "No coins have dropped out yet.",
    "funnel.scored": "Fully scored",
    "funnel.scoreBlocked": "Blocked by score",
    "funnel.devUnknown": "Creator unknown",
    "funnel.holderCheck": "Holder check",
    "funnel.on": "On",
    "funnel.off": "Off",
    "funnel.share": "{pct}% of those found",
    "funnel.market_cap": "Size outside the range",
    "funnel.capacity": "Watchlist full",
    "funnel.dev_history": "Bad creator history",
    "funnel.social": "Missing social links",
    "funnel.liquidity": "Liquidity too small",
    "funnel.volume": "One-hour volume too quiet",
    "funnel.holders": "Holders too concentrated",
    "funnel.expired": "Ran out of time: {stage}",

    "positions.eyebrow": "PRACTICE",
    "positions.title": "Coins held right now",
    "positions.empty": "No coins held yet.",
    "positions.cost": "{cost} · bought at {entry} · now {now}",
    "trades.eyebrow": "HISTORY",
    "trades.title": "Latest buys and sells",
    "trades.note": "last 20",
    "trades.empty": "No completed trades yet.",
    "th.entryMc": "MC when bought",
    "th.exitMc": "MC when sold",
    "th.reason": "Why it sold",
    "th.pnl": "Profit/loss",
    "trade.openedAt": "bought {time}",
    "trade.closedAt": "sold {time}",
    "trade.held": "held {duration}",
    "exit.take-profit": "Profit target",
    "exit.stop-loss": "Loss limit",
    "exit.max-hold": "Time limit",
    "exit.max-hold-stale": "Price went missing",
    "exit.exit": "Exit",

    "startup.eyebrow": "READINESS",
    "startup.ready": "Ready to start",
    "startup.readyBadge": "READY",
    "startup.readyMessage": "An API key is not required in free mode. Press “Start paper scanner”.",
    "startup.startingTitle": "Bots are starting",
    "startup.startingBadge": "STARTING",
    "startup.startingMessage": "Request received; waiting for the engine and the data connection.",
    "startup.stoppingTitle": "Bots are stopping",
    "startup.stoppingBadge": "STOPPING",
    "startup.stoppingMessage": "Waiting for the bot process to finish.",
    "startup.errorTitle": "Could not start",
    "startup.errorBadge": "ERROR",
    "startup.errorMessage": "The server reported an error but has not sent the details yet.",
    "startup.liveTitle": "Connected to the data source",
    "startup.liveBadge": "LIVE",
    "startup.liveMessage": "Connection is up; waiting for new coins to move to an AMM pool.",
    "startup.feedTitle": "Bots running, data not connected",
    "startup.feedBadge": "DATA",
    "startup.feedMessage": "Waiting for the connection. If this persists, check the API key and the technical log below.",
    "startup.tradeMissingTitle": "Coins arriving, trades not readable",
    "startup.tradeMissingBadge": "CHECK DATA",
    "startup.tradeMissingMessage": "The connection is up, but watched coins still show 0 trades. In free mode, give it a few seconds while DexScreener indexes the new pool.",
    "startup.uiErrorTitle": "The dashboard could not load data",
    "startup.uiErrorBadge": "UI ERROR",
    "startup.eventsEmpty": "No start attempts yet.",
    "startup.serverStale": "The running server has not loaded the latest diagnostics. Stop the npm start process once, start it again, then reload this page.",

    "form.eyebrow": "SETTINGS",
    "form.title": "Set the strategy",
    "form.tag": "PRACTICE",
    "form.sourceTitle": "Live data source",
    "form.sourceNote": "New coins are watched once they move to an AMM pool. A buy still waits for enough trades and buyers.",
    "form.keyTitle": "PumpPortal API key (optional)",
    "form.keySub": "Not required in free mode. Only used by your local server.",
    "form.keyPlaceholder": "Paste the API key here",
    "form.keyHelp": "No key yet?",
    "form.keyHelpLink": "Create one at PumpPortal ↗",
    "form.keyNote": "The key can grant trading access on PumpPortal. This dashboard only uses it for practice data and never stores it.",
    "form.sizeTitle": "Simulation size",
    "form.startBalance": "Starting balance",
    "form.buyAmount": "Money per buy",
    "form.maxOpen": "Positions at once",
    "form.maxEntries": "Buy limit per day",
    "form.sizeNote": "The starting balance only applies when you create or reset the practice account.",
    "form.filterTitle": "Coin filters",
    "form.minMc": "Minimum market cap",
    "form.maxMc": "Maximum market cap",
    "form.minTrades": "Minimum trades",
    "form.minBuys": "Minimum buys",
    "form.minBuyers": "Minimum different buyers",
    "form.maxAge": "Maximum candidate age",
    "form.socialMode": "Social link requirement",
    "form.social.twitter": "X/Twitter required",
    "form.social.any": "At least one: X, Telegram, or website",
    "form.social.multiple": "At least two kinds of link",
    "form.social.off": "No social filter",
    "form.socialNote": "The two-link option counts X/Twitter, Telegram, and a website as different kinds.",
    "form.exitTitle": "When to buy and sell",
    "form.pullback": "Dip from the peak",
    "form.bounce": "Bounce off the low",
    "form.takeProfit": "Profit target",
    "form.stopLoss": "Loss limit",
    "form.maxHold": "Maximum time holding",
    "form.maxDailyLoss": "Daily loss limit",
    "form.advanced": "Advanced settings",
    "form.maxActive": "Maximum watchlist size",
    "form.fee": "Simulated fee",
    "form.slippage": "Simulated slippage",
    "form.start": "Start paper scanner",
    "form.apply": "Apply now",
    "form.reset": "Reset practice account",
    "unit.sol": "SOL",
    "unit.usd": "USD",
    "unit.pct": "%",
    "unit.seconds": "seconds",
    "unit.bps": "bps / side",

    "msg.starting": "Starting the practice bots…",
    "msg.started": "Bots running. The balance and trades on this page are simulated.",
    "msg.applying": "Sending changes to the running bots…",
    "msg.applied": "Strategy applied without a restart.",
    "msg.stopping": "Asking the bots to stop…",
    "msg.reset": "Practice account reset.",
    "msg.resetConfirm": "Reset the practice balance and history to {balance} SOL? This clears the current simulation.",
    "msg.readError": "The dashboard could not read the server: {detail}",

    "info.title": "Free data mode",
    "info.body": "New coins from PumpPortal (free); prices and trade counts from DexScreener; unique buyers from GeckoTerminal. No SOL balance needed.",
    "info.link": "PumpPortal fee details ↗",
    "footer.note": "Market cap in USD is derived from the token price and SOL/USD. Practice results do not guarantee real fills or returns.",

    "help.pullback": "Pullback: the price falling back from its highest point. The bot refuses to buy at the very top, because that is where the drop risk is biggest.",
    "help.rebound": "Rebound: after the dip, the price starts rising again. That suggests buyers are returning, and that is when the bot buys.",
    "help.score": "A 0–1 quality score summarising the creator's history, liquidity, volume, and how spread out the holders are. Higher is safer by your own rules.",
    "help.liquidity": "Liquidity: how much money sits in the pool. If it is too small, even a small sell crashes the price.",
    "help.marketCap": "Market cap: the price of one coin times how many coins exist. A rough measure of how big the coin is.",
    "help.uniqueBuyers": "Different buyers: how many separate wallets bought, not how many buys happened. One person buying 50 times still counts as one.",
    "help.lane": "Each bot has one job and its own balance, so you can compare them: newborn coins, coins a few hours old, and coins a few days old.",
    "help.paper": "Practice mode: every buy and sell is only recorded on this computer. No wallet, no real money.",
    "help.devHistory": "Creator history: the bot remembers wallets that launched coins before, and rejects coins from creators whose previous coins collapsed.",
    "help.funnel": "This list counts why coins dropped out. If one reason dominates, that filter may be too strict.",
  },
};

let activeLang = readStoredLang();

function readStoredLang() {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored && LANG_SUPPORTED.includes(stored)) return stored;
  } catch {
    // private mode / blocked storage: fall through to the default
  }
  return LANG_DEFAULT;
}

function lang() {
  return activeLang;
}

function locale() {
  return activeLang === "en" ? "en-US" : "id-ID";
}

// Missing keys fall back to the other language and then to the key itself, so a half-translated
// dictionary degrades into readable text instead of blank UI.
function t(key, params) {
  const table = I18N[activeLang] ?? I18N[LANG_DEFAULT];
  let text = table[key] ?? I18N[LANG_DEFAULT][key] ?? I18N.en[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

// Count-aware lookup: uses "<key>.one" when the count is exactly 1 and that form exists.
// Indonesian does not inflect for number, so it simply has no ".one" entries and falls through.
function tn(key, count, params) {
  const singular = `${key}.one`;
  const table = I18N[activeLang] ?? I18N[LANG_DEFAULT];
  if (Number(count) === 1 && (table[singular] ?? I18N[LANG_DEFAULT][singular])) {
    return t(singular, { n: count, ...params });
  }
  return t(key, { n: count, ...params });
}

const langListeners = new Set();

function onLangChange(listener) {
  langListeners.add(listener);
}

function setLang(next) {
  if (!LANG_SUPPORTED.includes(next) || next === activeLang) return;
  activeLang = next;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, next);
  } catch {
    // choice simply will not survive a reload
  }
  applyStaticText();
  for (const listener of langListeners) listener(next);
}

// ---------- locale-aware formatting ----------
// These follow the active language, so "1.234,5" / "1,234.5" match the surrounding text.

function fmtSol(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })} SOL`;
}

function fmtSolSigned(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${fmtSol(n, digits)}`;
}

function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 1 })}M`;
  if (n >= 1_000) return `$${(n / 1_000).toLocaleString(locale(), { maximumFractionDigits: 0 })}K`;
  return `$${n.toLocaleString(locale(), { maximumFractionDigits: 0 })}`;
}

function fmtUsdExact(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `$${n.toLocaleString(locale(), { maximumFractionDigits: 0 })}`;
}

function fmtPct(fraction, digits = 1) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toLocaleString(locale(), { maximumFractionDigits: digits })}%`;
}

function fmtInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n).toLocaleString(locale()) : "0";
}

function fmtClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "--:--:--";
  return date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Translates the static markup. data-i18n sets textContent; data-i18n-html allows the few
// strings with a <br />; data-i18n-attr carries "attr:key" pairs for placeholder/title/aria.
function applyStaticText() {
  document.documentElement.lang = activeLang;
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll("[data-i18n-html]")) {
    // Dictionary content only: never token names or any other untrusted text.
    node.innerHTML = t(node.dataset.i18nHtml);
  }
  for (const node of document.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of node.dataset.i18nAttr.split(",")) {
      const [attr, key] = pair.split(":").map((part) => part.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    }
  }
  for (const node of document.querySelectorAll("[data-help]")) {
    node.setAttribute("title", t(node.dataset.help));
    node.setAttribute("aria-label", t(node.dataset.help));
  }
}

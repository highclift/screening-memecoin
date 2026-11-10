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
    "top.subtitle": "Tiga bot bekerja berurutan: bot 1 men-screening semua koin, bot 2 menyaring, bot 3 beli dan jual.",
    "feed.connected": "Feed terhubung",
    "feed.connecting": "Menghubungkan feed",
    "feed.disconnected": "Feed terputus",
    "button.stop": "Hentikan bot",

    "hero.label": "LINGKUNGAN LATIHAN",
    "hero.labelRight": "TANPA TANDA TANGAN WALLET",
    "hero.title1": "Uji strategimu",
    "hero.title2": "sebelum masuk pasar.",
    "hero.body": "Bot 1 melihat semua koin, baru maupun yang sudah lama. Bot 2 mencari yang berpotensi pump lagi. Bot 3 mengukur ayunan harga tiap koin lalu menentukan sendiri kapan masuk dan keluar.",
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
    "runtime.detail.running": "Bot 1 men-screening koin, bot 2 menilai, bot 3 menunggu momen masuk. Saldo tetap latihan.",
    "runtime.detail.connecting": "Menyambung ke sumber data.",
    "runtime.detail.hasKey": "API key ditemukan; tekan Mulai.",
    "runtime.detail.noKey": "API key tidak wajib di mode gratis; tekan Mulai.",

    // ---------- "what is happening" headline ----------
    "now.eyebrow": "SEDANG TERJADI",
    "now.title": "Apa yang bot lakukan sekarang",
    "now.stopped": "Bot belum berjalan. Tekan “Mulai paper scanner” di bawah dan halaman ini akan menjelaskan setiap langkahnya.",
    "now.starting": "Bot sedang dinyalakan. Sebentar lagi mulai mencari koin.",
    "now.stopping": "Bot sedang dimatikan.",
    "now.error": "Bot berhenti karena ada masalah. Penjelasannya ada di kartu merah di bawah.",
    "now.connecting": "Bot menyala, tapi belum tersambung ke sumber data koin. Biasanya ini selesai sendiri dalam beberapa detik.",
    "now.idle": "Ketiga bot berjalan. Bot 1 sedang mengumpulkan koin untuk dinilai bot 2.",
    "now.holding": "Bot 3 sedang memegang {positions}, dan bot 2 masih memantau {coins} berpotensi pump.",
    "frag.coins": "{n} koin",
    "frag.positions": "{n} posisi latihan",

    // ---------- metrics ----------
    "metric.balance": "Saldo latihan",
    "metric.balanceFoot": "SOL yang bisa dipakai beli",
    "metric.pnl": "Untung/rugi hari ini",
    "metric.pnlFoot": "Sudah termasuk fee dan slippage simulasi",
    "metric.positions": "Posisi terbuka",
    "metric.positionsFoot": "Batas bersamaan {limit}",
    "metric.entries": "Pembelian hari ini",
    "metric.entriesFoot": "Batas harian {limit}",

    // ---------- feed (plain language) ----------
    "activity.eyebrow": "SIARAN LANGSUNG",
    "activity.title": "Cerita langkah demi langkah",
    "activity.note": "Bahasa sehari-hari",
    "activity.empty": "Cerita akan muncul di sini begitu bot dijalankan.",
    "activity.technical": "Detail teknis (log asli)",
    "activity.technicalEmpty": "Belum ada log.",

    "ev.start": "Bot dijalankan dengan saldo latihan {balance} dan {buy} per pembelian.",
    "ev.pipeline": "Rantai tiga bot siap: screening semua koin, lalu saringan, lalu eksekusi.",
    "ev.feedConnected": "Tersambung ke PumpPortal: koin yang baru lahir dan yang pindah ke pool AMM langsung masuk.",
    "ev.feedDisconnected": "Sambungan data terputus. Mencoba menyambung lagi dalam {seconds} detik.",
    "ev.feedError": "Sumber data menolak permintaan: {detail}",
    "ev.feedNotice": "Pesan dari sumber data: {detail}",
    "ev.subMigration": "Bot kini mendengarkan koin yang pindah ke pool AMM.",
    "ev.subNewCoins": "Bot kini mendengarkan koin baru yang baru saja dibuat.",
    "ev.subGeneric": "Bot berhasil berlangganan pemberitahuan dari sumber data.",
    "ev.exit.stopLoss": "Jual {token} karena menyentuh batas rugi: {pnl}.",
    "ev.exit.maxHold": "Jual {token} karena sudah dipegang terlalu lama: {pnl}.",
    "ev.exit.stale": "Jual {token} karena harganya tidak terbaca lagi: {pnl}.",
    "ev.exit.other": "Jual {token}: {pnl}.",
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

    // reasons a coin is skipped
    "reason.market_cap": "ukurannya di luar rentang yang kamu minta",
    "reason.dev_history": "pembuatnya pernah meluncurkan koin yang harganya hancur",
    "reason.liquidity": "uang di pool-nya terlalu sedikit untuk keluar dengan aman",
    "reason.holders": "beberapa dompet memegang terlalu banyak koin ini",
    "reason.unknown": "tidak memenuhi salah satu syarat",

    // ---------- screener / funnel ----------
    "screener.eyebrow": "HASIL SARINGAN BOT 2",
    "screener.title": "Koin yang berpotensi pump",
    "screener.stopped": "BOT BERHENTI",
    "screener.starting": "SEDANG MENYALA",
    "screener.stopping": "SEDANG BERHENTI",
    "screener.error": "BOT ERROR",
    "screener.waitingFeed": "MENUNGGU SAMBUNGAN",
    "screener.live": "AKTIF · MENCARI KOIN",
    "screener.countMiddle": "koin hijau dari maksimum",
    "screener.empty": "Belum ada koin yang dinilai. Tekan Mulai dan bot 1 akan langsung men-screening.",
    "th.token": "Koin",
    "th.marketCap": "Market cap USD",
    "th.age": "Umur",

    "funnel.title": "Mengapa koin ditolak",
    "funnel.note": "sejak bot dijalankan",
    "funnel.empty": "Belum ada koin yang gugur.",
    "funnel.holderCheck": "Cek sebaran holder",
    "funnel.on": "Aktif",
    "funnel.off": "Mati",
    "funnel.share": "{pct}% dari yang ditemukan",

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
    "exit.stop-loss": "Batas rugi",
    "exit.max-hold": "Waktu habis",
    "exit.max-hold-stale": "Harga hilang",
    "exit.exit": "Keluar",

    // ---------- start diagnostics ----------
    "startup.eyebrow": "KESIAPAN",
    "startup.ready": "Siap dijalankan",
    "startup.readyBadge": "SIAP",
    "startup.readyMessage": "Tekan Mulai. Bot 1 akan men-screening ratusan koin per menit, bot 2 menyaringnya, bot 3 yang memutuskan beli dan jual.",
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
    "startup.liveMessage": "Ketiga bot berjalan. Bot 1 terus mengirim koin ke bot 2; bot 3 hanya bertindak pada koin hijau.",
    "startup.feedTitle": "Bot jalan, data belum tersambung",
    "startup.feedBadge": "DATA",
    "startup.feedMessage": "Menunggu sambungan. Kalau terus begini, periksa API key dan log teknis di bawah.",
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
    "form.startBalance": "Saldo awal",
    "form.buyAmount": "Uang per pembelian",
    "form.maxOpen": "Posisi bersamaan",
    "form.maxEntries": "Batas beli per hari",
    "form.sizeNote": "Saldo awal hanya berlaku saat membuat atau mereset akun latihan.",
    "form.maxDailyLoss": "Batas rugi harian",
    "form.start": "Mulai paper scanner",
    "form.apply": "Terapkan sekarang",
    "form.reset": "Reset akun latihan",
    "unit.sol": "SOL",
    "unit.usd": "USD",

    "msg.starting": "Menyalakan bot latihan…",
    "msg.started": "Bot jalan. Saldo dan jual-beli di halaman ini hanya simulasi.",
    "msg.applying": "Mengirim perubahan ke bot yang sedang jalan…",
    "msg.applied": "Strategi diterapkan tanpa perlu restart.",
    "msg.stopping": "Meminta bot berhenti…",
    "msg.reset": "Akun latihan berhasil direset.",
    "msg.resetConfirm": "Reset saldo dan riwayat latihan ke {balance} SOL? Ini menghapus simulasi yang sekarang.",
    "msg.readError": "Dashboard tidak bisa membaca server: {detail}",

    // ---------- info + footer ----------
    "info.title": "Semua sumber data gratis",
    "info.body": "Koin baru dari PumpPortal; halaman pool baru/trending/volume teratas dari GeckoTerminal; market cap, likuiditas, dan volume dari DexScreener. Tanpa API key, tanpa saldo SOL.",
    "info.link": "Rincian biaya PumpPortal ↗",
    "footer.note": "Market cap USD dihitung dari harga token dan SOL/USD. Hasil latihan tidak menjamin harga atau hasil sungguhan.",

    // ---------- jargon tooltips ----------
    "help.score": "Skor 0–1 dari bot 2: seberapa besar peluang koin ini pump atau pump lagi. Dihitung dari volume dibanding jam biasanya, tekanan beli, jumlah pembeli berbeda, arah harga, dan kedalaman pool.",
    "help.liquidity": "Likuiditas: jumlah uang di dalam pool. Kalau terlalu kecil, menjual sedikit saja sudah menjatuhkan harga.",
    "help.marketCap": "Market cap: harga satu koin dikali jumlah koin yang ada. Ini ukuran kasar seberapa besar koin itu.",
    "help.uniqueBuyers": "Pembeli berbeda: berapa banyak dompet yang membeli, bukan berapa kali pembelian terjadi. Satu orang membeli 50 kali tetap dihitung satu.",
    "help.paper": "Mode latihan: semua pembelian dan penjualan hanya dicatat di komputer ini. Tidak ada wallet, tidak ada uang sungguhan.",
    "help.devHistory": "Riwayat pembuat: bot mengingat dompet yang pernah meluncurkan koin, dan menolak koin dari pembuat yang koin sebelumnya jatuh.",
    "help.funnel": "Daftar ini menghitung alasan bot 2 menolak koin. Kalau satu alasan mendominasi, saringan itu yang paling layak diperiksa.",

    // ---------- the three bots ----------
    "bots.eyebrow": "RANTAI TIGA BOT",
    "bots.title": "Bot dan tugasnya",
    "bots.note": "Bot 1 → bot 2 → bot 3",
    "bot.on": "JALAN",
    "bot.off": "BERHENTI",
    "bot.now.off": "Belum berjalan.",
    "bot.now.notStarted": "Menunggu laporan pertama dari bot.",
    "bot.screener.name": "Bot 1 · Screening",
    "bot.screener.stage": "semua koin, umur berapa pun",
    "bot.screener.badge": "BOT 1",
    "bot.screener.task": "Melihat setiap koin yang bisa ditemukan — yang baru lahir maupun yang dibuat sebulan lalu — dan mencatat semuanya. Bot ini tidak menilai apa pun.",
    "bot.screener.detailsToggle": "Koin terakhir yang di-screening",
    "bot.screener.listEmpty": "Belum ada koin yang di-screening.",
    "bot.screener.listRow": "umur {age} · {marketCap}",
    "bot.screener.now.waiting": "Mulai menyapu halaman pool; koin pertama segera masuk.",
    "bot.screener.now.working": "{perMinute} pemeriksaan per menit, {newPerMinute} koin baru per menit; {coins} koin berbeda sejauh ini.",
    "bot.filter.name": "Bot 2 · Saringan",
    "bot.filter.stage": "bisa pump atau pump lagi?",
    "bot.filter.badge": "BOT 2",
    "bot.filter.task": "Menilai ulang semua koin dari bot 1, terus-menerus. Koin lama yang sepi berbulan-bulan bisa jadi hijau pada jam volumenya bangun.",
    "bot.filter.detailsToggle": "Koin yang baru jadi hijau",
    "bot.filter.listEmpty": "Belum ada koin yang lolos.",
    "bot.filter.listRow": "skor {score} · {reason} · umur {age}",
    "bot.filter.now.waiting": "Menunggu koin pertama dari bot 1.",
    "bot.filter.now.green": "{coins} dinilai berpotensi pump dan diserahkan ke bot 3.",
    "bot.filter.now.none": "Sudah menilai {judged} koin; belum ada yang cukup kuat.",
    "bot.executor.name": "Bot 3 · Eksekusi",
    "bot.executor.stage": "kapan masuk, kapan keluar",
    "bot.executor.badge": "BOT 3",
    "bot.executor.task": "Mengukur sendiri ayunan harga tiap koin hijau, lalu menentukan jarak stop, trailing, dan momen masuknya. Tidak ada angka strategi yang perlu diatur.",
    "bot.executor.detailsToggle": "Yang sedang ditunggu",
    "bot.executor.listEmpty": "Belum ada koin yang dipantau.",
    "bot.executor.now.idle": "Menunggu koin hijau dari bot 2.",
    "bot.executor.now.watching": "Memantau {coins} dan menunggu momen masuk.",
    "bot.executor.now.holding": "Sedang memegang {positions}.",
    "bot.executor.now.blocked": "Entry tertahan: {reason}.",
    "bot.stat.coins": "Koin di-screening",
    "bot.stat.perMinute": "Pemeriksaan per menit",
    "bot.stat.newPerMinute": "Koin baru per menit",
    "bot.stat.universe": "Koin dalam pantauan",
    "bot.stat.launches": "Koin baru / migrasi",
    "bot.stat.judged": "Penilaian dibuat",
    "bot.stat.green": "Hijau sekarang / total",
    "bot.stat.red": "Ditolak",
    "bot.stat.topReason": "Alasan terbanyak",
    "bot.stat.balance": "Saldo latihan",
    "bot.stat.pnl": "Untung/rugi",
    "bot.stat.open": "Posisi terbuka",
    "bot.stat.record": "Menang / kalah",
    "bot.stat.watching": "Dipantau",
    "bot.stat.entriesToday": "Beli hari ini",
    "bot3.holding": "Sedang dipegang",
    "bot3.notWatching": "Belum dipantau",
    // ---------- what bot 3 is waiting for ----------
    "waiting.measure": "Mengukur ayunan harga koin ini",
    "waiting.dip": "Menunggu harga turun {dip}% dari puncak",
    "waiting.bounce": "Menunggu pantulan {bounce}% dari titik rendah",
    "waiting.buyers": "Menunggu pembeli kembali mendominasi",
    "waiting.spike": "Lonjakan terlalu tajam; menunggu harga tenang",
    "waiting.data": "Menunggu data harga",
    "waiting.entry": "Sinyal masuk terpenuhi",
    "waiting.unknown": "Sedang dinilai",
    // ---------- why bot 2 said yes ----------
    "lead.surge": "volume bangun",
    "lead.buyPressure": "pembeli lebih banyak dari penjual",
    "lead.breadth": "banyak dompet berbeda membeli",
    "lead.momentum": "harga bergerak naik",
    "lead.depth": "pool cukup dalam",
    "frag.times": "{times}× lipat",
    "frag.timesPool": "{times}× isi pool",
    "ev.bot2.greenTurnover": "Bot 2: {token} berpotensi pump (skor {score}) — {times}× isi pool diperdagangkan dalam sejam, umur {age}.",
    "reason.liquidity_ratio": "likuiditas terlalu kecil dibanding ukuran koinnya",
    "reason.dead": "hampir tidak ada transaksi satu jam terakhir",
    "reason.dead_volume": "volume satu jam terlalu kecil",
    "reason.low_score": "skor potensi pump terlalu rendah",
    "reason.no_data": "menunggu data market cap dan likuiditas",
    "reason.building": "skor sedang naik tapi belum cukup",
    "reason.holders_pending": "menunggu hasil cek sebaran holder",
    "reason.green": "lolos",
    "screener.screened": "Koin di-screening bot 1",
    "screener.perMinute": "Koin baru per menit",
    "screener.rejected": "Ditolak bot 2",
    "screener.bought": "Dibeli bot 3 (latihan)",
    "screener.greenList": "Daftar hijau",
    "screener.greenNote": "skor tertinggi dulu",
    "screener.emptyScreening": "Bot 1 sedang men-screening, tapi belum ada koin yang dinilai berpotensi pump.",
    "th.score": "Skor & alasan",
    "th.surge": "Volume vs jam biasanya",
    "th.bot3": "Bot 3",
    "funnel.judged": "Penilaian bot 2",
    "funnel.watching": "Masih dipantau",
    "funnel.rugs": "Koin jatuh (rug)",
    "now.green": "Bot 2 menandai {coins} berpotensi pump; bot 1 terus men-screening {perMinute} koin per menit.",
    "now.screening": "Bot 1 sudah men-screening {coins} ({perMinute} per menit); bot 2 belum menemukan yang cukup kuat.",
    "exit.trail": "trailing stop",
    "exit.trail-locked": "trailing stop (untung dijaga)",
    "exit.stall": "berhenti naik",
    "exit.breakdown": "penjual mengambil alih",
    "ev.shutdown": "Ketiga bot berhenti; akun latihan disimpan.",
    "ev.greenScore": "Bot 2 menandai koin hijau mulai skor {score}.",
    "ev.bot1.started": "Bot 1 mulai men-screening: {pages} halaman pool bergilir tiap {seconds} detik, plus {batch} koin disegarkan tiap {refresh} detik.",
    "ev.bot1.error": "Bot 1 gagal mengambil data: {detail}",
    "ev.bot2.green": "Bot 2: {token} berpotensi pump (skor {score}, {reason}), umur {age}.",
    "ev.bot2.greenSurge": "Bot 2: {token} berpotensi pump (skor {score}) — volume {times}× jam biasanya, umur {age}.",
    "ev.bot2.ungreen": "Bot 2 menarik status hijau {token}: {reason}",
    "ev.bot3.buy": "Bot 3 beli {token} di {mc} setelah turun {dip}% lalu memantul {bounce}%. Stop {stop}%, trailing {trail}% (koin ini bergerak ~{vol}% per menit).",
    "ev.exit.trail": "Bot 3 jual {token} kena trailing stop: {pnl}",
    "ev.exit.trailLocked": "Bot 3 jual {token} untuk menjaga untung: {pnl}",
    "ev.exit.stall": "Bot 3 jual {token} karena berhenti naik: {pnl}",
    "ev.exit.breakdown": "Bot 3 jual {token} karena penjual mengambil alih: {pnl}",
    "startup.dataMissingTitle": "Data pasar belum masuk",
    "startup.dataMissingBadge": "PERIKSA",
    "startup.dataMissingMessage": "Bot 1 menemukan koin, tapi market cap dan likuiditasnya tidak terbaca, jadi bot 2 tidak bisa menilai apa pun. Biasanya DexScreener sedang membatasi permintaan.",
    "form.moneyTitle": "Batas uang",
    "form.decideTitle": "Yang diputuskan bot sendiri",
    "form.decideNote": "Bot 2 menilai koin mana yang berpotensi pump; bot 3 mengukur ayunan harga tiap koin lalu menentukan sendiri kapan masuk, stop, dan jual. Tidak ada angka strategi untuk diatur di sini.",
    "help.chain": "Tiga bot berurutan, bukan tiga bot terpisah: bot 1 men-screening semua koin, bot 2 menyaring hasilnya, bot 3 mengeksekusi koin yang lolos. Satu akun latihan untuk ketiganya.",
    "help.perMinute": "Berapa kali bot 1 memeriksa sebuah koin dalam satu menit terakhir, termasuk koin yang dilihat berulang. Ratusan per menit itu normal.",
    "help.green": "Hijau berarti bot 2 menilai koin itu berpotensi pump sekarang. Status ini dinilai ulang terus, jadi bisa dicabut lagi.",
    "help.record": "Jumlah transaksi latihan yang ditutup untung berbanding rugi.",
    "help.watching": "Koin hijau yang sedang diamati bot 3 sambil menunggu momen masuk.",
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
    "top.subtitle": "Three bots in a chain: bot 1 screens every coin, bot 2 filters, bot 3 buys and sells.",
    "feed.connected": "Feed connected",
    "feed.connecting": "Connecting feed",
    "feed.disconnected": "Feed offline",
    "button.stop": "Stop the bot",

    "hero.label": "PRACTICE ENVIRONMENT",
    "hero.labelRight": "NO WALLET SIGNING",
    "hero.title1": "Test your strategy",
    "hero.title2": "before you risk money.",
    "hero.body": "Bot 1 looks at every coin, new or months old. Bot 2 looks for the ones that can pump again. Bot 3 measures how each coin swings and decides its own entry and exit.",
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
    "runtime.detail.running": "Bot 1 is screening coins, bot 2 is judging them, bot 3 is waiting for its moment. The balance stays pretend.",
    "runtime.detail.connecting": "Connecting to the data source.",
    "runtime.detail.hasKey": "API key found; press Start.",
    "runtime.detail.noKey": "An API key is optional in free mode; press Start.",

    "now.eyebrow": "HAPPENING NOW",
    "now.title": "What the bots are doing right now",
    "now.stopped": "The bots are not running yet. Press “Start paper scanner” below and this page will narrate every step.",
    "now.starting": "The bots are starting up. They will begin looking for coins in a moment.",
    "now.stopping": "The bots are shutting down.",
    "now.error": "The bots stopped because something went wrong. The red card below explains it.",
    "now.connecting": "The bots are running but not connected to the coin data source yet. This usually clears itself within seconds.",
    "now.idle": "All three bots are running. Bot 1 is gathering coins for bot 2 to judge.",
    "now.holding": "Bot 3 is holding {positions}, and bot 2 is still watching {coins} that could pump.",
    "frag.coins": "{n} coins",
    "frag.coins.one": "1 coin",
    "frag.positions": "{n} practice positions",
    "frag.positions.one": "1 practice position",

    "metric.balance": "Practice balance",
    "metric.balanceFoot": "SOL available to buy with",
    "metric.pnl": "Profit/loss today",
    "metric.pnlFoot": "Simulated fees and slippage included",
    "metric.positions": "Open positions",
    "metric.positionsFoot": "Limit {limit} at once",
    "metric.entries": "Buys today",
    "metric.entriesFoot": "Daily limit {limit}",

    "activity.eyebrow": "LIVE",
    "activity.title": "Step-by-step story",
    "activity.note": "Everyday language",
    "activity.empty": "The story appears here once the bots are running.",
    "activity.technical": "Technical details (raw log)",
    "activity.technicalEmpty": "No log lines yet.",

    "ev.start": "The bots started with a {balance} practice balance and {buy} per buy.",
    "ev.pipeline": "The three-bot chain is up: screen every coin, then filter, then execute.",
    "ev.feedConnected": "Connected to PumpPortal: newborn coins and coins moving to an AMM pool now arrive instantly.",
    "ev.feedDisconnected": "Data connection dropped. Trying again in {seconds} seconds.",
    "ev.feedError": "The data source rejected a request: {detail}",
    "ev.feedNotice": "Message from the data source: {detail}",
    "ev.subMigration": "The bot is now listening for coins moving to an AMM pool.",
    "ev.subNewCoins": "The bot is now listening for brand-new coins.",
    "ev.subGeneric": "The bot subscribed to notifications from the data source.",
    "ev.exit.stopLoss": "Sold {token} because it hit the loss limit: {pnl}.",
    "ev.exit.maxHold": "Sold {token} because it was held too long: {pnl}.",
    "ev.exit.stale": "Sold {token} because its price stopped updating: {pnl}.",
    "ev.exit.other": "Sold {token}: {pnl}.",
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

    "reason.market_cap": "its size is outside the range you asked for",
    "reason.dev_history": "the same creator has launched coins that collapsed before",
    "reason.liquidity": "there is too little money in its pool to exit safely",
    "reason.holders": "a few wallets hold too much of the supply",
    "reason.unknown": "it failed one of the checks",

    "screener.eyebrow": "BOT 2 RESULTS",
    "screener.title": "Coins that could pump",
    "screener.stopped": "BOTS STOPPED",
    "screener.starting": "STARTING UP",
    "screener.stopping": "SHUTTING DOWN",
    "screener.error": "BOT ERROR",
    "screener.waitingFeed": "WAITING FOR CONNECTION",
    "screener.live": "LIVE · LOOKING FOR COINS",
    "screener.countMiddle": "green coins of at most",
    "screener.empty": "No coins judged yet. Press Start and bot 1 begins screening immediately.",
    "th.token": "Coin",
    "th.marketCap": "Market cap USD",
    "th.age": "Age",

    "funnel.title": "Why coins were turned down",
    "funnel.note": "since the bots started",
    "funnel.empty": "No coins have dropped out yet.",
    "funnel.holderCheck": "Holder spread check",
    "funnel.on": "On",
    "funnel.off": "Off",
    "funnel.share": "{pct}% of those found",

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
    "exit.stop-loss": "Loss limit",
    "exit.max-hold": "Time limit",
    "exit.max-hold-stale": "Price went missing",
    "exit.exit": "Exit",

    "startup.eyebrow": "READINESS",
    "startup.ready": "Ready to start",
    "startup.readyBadge": "READY",
    "startup.readyMessage": "Press Start. Bot 1 will screen hundreds of coins a minute, bot 2 filters them, and bot 3 decides what to buy and sell.",
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
    "startup.liveMessage": "All three bots are running. Bot 1 keeps feeding coins to bot 2; bot 3 only acts on green ones.",
    "startup.feedTitle": "Bots running, data not connected",
    "startup.feedBadge": "DATA",
    "startup.feedMessage": "Waiting for the connection. If this persists, check the API key and the technical log below.",
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
    "form.startBalance": "Starting balance",
    "form.buyAmount": "Money per buy",
    "form.maxOpen": "Positions at once",
    "form.maxEntries": "Buy limit per day",
    "form.sizeNote": "The starting balance only applies when you create or reset the practice account.",
    "form.maxDailyLoss": "Daily loss limit",
    "form.start": "Start paper scanner",
    "form.apply": "Apply now",
    "form.reset": "Reset practice account",
    "unit.sol": "SOL",
    "unit.usd": "USD",

    "msg.starting": "Starting the practice bots…",
    "msg.started": "Bots running. The balance and trades on this page are simulated.",
    "msg.applying": "Sending changes to the running bots…",
    "msg.applied": "Strategy applied without a restart.",
    "msg.stopping": "Asking the bots to stop…",
    "msg.reset": "Practice account reset.",
    "msg.resetConfirm": "Reset the practice balance and history to {balance} SOL? This clears the current simulation.",
    "msg.readError": "The dashboard could not read the server: {detail}",

    "info.title": "Every data source is free",
    "info.body": "New coins from PumpPortal; new / trending / top-volume pool pages from GeckoTerminal; market cap, liquidity and volume from DexScreener. No API key, no SOL balance.",
    "info.link": "PumpPortal fee details ↗",
    "footer.note": "Market cap in USD is derived from the token price and SOL/USD. Practice results do not guarantee real fills or returns.",

    "help.score": "Bot 2's 0–1 score: how likely this coin is to pump, or pump again. Built from its volume against a normal hour for itself, buy pressure, how many different wallets are buying, which way the price is going, and how deep the pool is.",
    "help.liquidity": "Liquidity: how much money sits in the pool. If it is too small, even a small sell crashes the price.",
    "help.marketCap": "Market cap: the price of one coin times how many coins exist. A rough measure of how big the coin is.",
    "help.uniqueBuyers": "Different buyers: how many separate wallets bought, not how many buys happened. One person buying 50 times still counts as one.",
    "help.paper": "Practice mode: every buy and sell is only recorded on this computer. No wallet, no real money.",
    "help.devHistory": "Creator history: the bot remembers wallets that launched coins before, and rejects coins from creators whose previous coins collapsed.",
    "help.funnel": "This list counts why bot 2 turned coins down. If one reason dominates, that is the gate worth looking at first.",

    // ---------- the three bots ----------
    "bots.eyebrow": "THE THREE-BOT CHAIN",
    "bots.title": "The bots and their jobs",
    "bots.note": "bot 1 → bot 2 → bot 3",
    "bot.on": "RUNNING",
    "bot.off": "STOPPED",
    "bot.now.off": "Not running yet.",
    "bot.now.notStarted": "Waiting for the bots' first report.",
    "bot.screener.name": "Bot 1 · Screening",
    "bot.screener.stage": "every coin, any age",
    "bot.screener.badge": "BOT 1",
    "bot.screener.task": "Looks at every coin it can find — newborn ones and ones created a month ago — and writes down what it saw. It judges nothing.",
    "bot.screener.detailsToggle": "Coins screened most recently",
    "bot.screener.listEmpty": "No coins screened yet.",
    "bot.screener.listRow": "{age} old · {marketCap}",
    "bot.screener.now.waiting": "Starting to sweep the pool pages; the first coins arrive shortly.",
    "bot.screener.now.working": "{perMinute} checks a minute, {newPerMinute} new coins a minute; {coins} different coins so far.",
    "bot.filter.name": "Bot 2 · Filter",
    "bot.filter.stage": "can it pump, or pump again?",
    "bot.filter.badge": "BOT 2",
    "bot.filter.task": "Re-judges everything bot 1 screens, over and over. A coin that has been quiet for months can turn green the hour its volume wakes up.",
    "bot.filter.detailsToggle": "Coins that just went green",
    "bot.filter.listEmpty": "No coin has passed yet.",
    "bot.filter.listRow": "score {score} · {reason} · {age} old",
    "bot.filter.now.waiting": "Waiting for the first coins from bot 1.",
    "bot.filter.now.green": "{coins} judged able to pump and handed to bot 3.",
    "bot.filter.now.none": "Judged {judged} coins so far; none strong enough yet.",
    "bot.executor.name": "Bot 3 · Execution",
    "bot.executor.stage": "when to buy, when to get out",
    "bot.executor.badge": "BOT 3",
    "bot.executor.task": "Measures how each green coin swings, then sets its own stop distance, trailing stop and entry moment. There are no strategy numbers to set.",
    "bot.executor.detailsToggle": "What it is waiting for",
    "bot.executor.listEmpty": "No coins being watched yet.",
    "bot.executor.now.idle": "Waiting for green coins from bot 2.",
    "bot.executor.now.watching": "Watching {coins} for the right moment to buy.",
    "bot.executor.now.holding": "Holding {positions} right now.",
    "bot.executor.now.blocked": "Entry held back: {reason}.",
    "bot.stat.coins": "Coins screened",
    "bot.stat.perMinute": "Checks per minute",
    "bot.stat.newPerMinute": "New coins per minute",
    "bot.stat.universe": "Coins being tracked",
    "bot.stat.launches": "New coins / migrations",
    "bot.stat.judged": "Judgements made",
    "bot.stat.green": "Green now / total",
    "bot.stat.red": "Turned down",
    "bot.stat.topReason": "Most common reason",
    "bot.stat.balance": "Practice balance",
    "bot.stat.pnl": "Profit/loss",
    "bot.stat.open": "Open positions",
    "bot.stat.record": "Wins / losses",
    "bot.stat.watching": "Being watched",
    "bot.stat.entriesToday": "Buys today",
    "bot3.holding": "Holding it",
    "bot3.notWatching": "Not watched yet",
    // ---------- what bot 3 is waiting for ----------
    "waiting.measure": "Measuring how this coin swings",
    "waiting.dip": "Waiting for a {dip}% dip from the peak",
    "waiting.bounce": "Waiting for a {bounce}% bounce off the low",
    "waiting.buyers": "Waiting for buyers to take over again",
    "waiting.spike": "The jump was too vertical; waiting for it to settle",
    "waiting.data": "Waiting for price data",
    "waiting.entry": "Entry signal met",
    "waiting.unknown": "Being judged",
    // ---------- why bot 2 said yes ----------
    "lead.surge": "volume waking up",
    "lead.buyPressure": "more buyers than sellers",
    "lead.breadth": "many different wallets buying",
    "lead.momentum": "price moving up",
    "lead.depth": "pool deep enough",
    "frag.times": "{times}×",
    "frag.timesPool": "{times}× the pool",
    "ev.bot2.greenTurnover": "Bot 2: {token} could pump (score {score}) — {times}× the whole pool traded in an hour, {age} old.",
    "reason.liquidity_ratio": "liquidity too small for the size of the coin",
    "reason.dead": "almost no trades in the last hour",
    "reason.dead_volume": "1h volume too small",
    "reason.low_score": "pump score too low",
    "reason.no_data": "waiting for market cap and liquidity data",
    "reason.building": "score is climbing but not there yet",
    "reason.holders_pending": "waiting for the holder spread check",
    "reason.green": "passed",
    "screener.screened": "Coins screened by bot 1",
    "screener.perMinute": "New coins per minute",
    "screener.rejected": "Turned down by bot 2",
    "screener.bought": "Bought by bot 3 (practice)",
    "screener.greenList": "Green list",
    "screener.greenNote": "highest score first",
    "screener.emptyScreening": "Bot 1 is screening, but no coin looks able to pump yet.",
    "th.score": "Score & reason",
    "th.surge": "Volume vs a normal hour",
    "th.bot3": "Bot 3",
    "funnel.judged": "Bot 2 judgements",
    "funnel.watching": "Still watching",
    "funnel.rugs": "Coins that collapsed",
    "now.green": "Bot 2 has flagged {coins} that could pump; bot 1 keeps screening {perMinute} coins a minute.",
    "now.screening": "Bot 1 has screened {coins} ({perMinute} a minute); bot 2 has not found one strong enough yet.",
    "exit.trail": "trailing stop",
    "exit.trail-locked": "trailing stop (profit locked)",
    "exit.stall": "stopped making highs",
    "exit.breakdown": "sellers took over",
    "ev.shutdown": "All three bots stopped; the practice account is saved.",
    "ev.greenScore": "Bot 2 calls a coin green from score {score} upwards.",
    "ev.bot1.started": "Bot 1 started screening: {pages} pool pages round-robin every {seconds}s, plus {batch} coins refreshed every {refresh}s.",
    "ev.bot1.error": "Bot 1 could not fetch data: {detail}",
    "ev.bot2.green": "Bot 2: {token} could pump (score {score}, {reason}), {age} old.",
    "ev.bot2.greenSurge": "Bot 2: {token} could pump (score {score}) — volume {times}× a normal hour, {age} old.",
    "ev.bot2.ungreen": "Bot 2 took green away from {token}: {reason}",
    "ev.bot3.buy": "Bot 3 bought {token} at {mc} after a {dip}% dip and a {bounce}% bounce. Stop {stop}%, trailing {trail}% (this coin moves ~{vol}% a minute).",
    "ev.exit.trail": "Bot 3 sold {token} on its trailing stop: {pnl}",
    "ev.exit.trailLocked": "Bot 3 sold {token} to lock the profit in: {pnl}",
    "ev.exit.stall": "Bot 3 sold {token} because it stopped making highs: {pnl}",
    "ev.exit.breakdown": "Bot 3 sold {token} because sellers took over: {pnl}",
    "startup.dataMissingTitle": "Market data is not arriving",
    "startup.dataMissingBadge": "CHECK",
    "startup.dataMissingMessage": "Bot 1 is finding coins, but their market cap and liquidity are not coming through, so bot 2 cannot judge anything. Usually DexScreener is rate limiting us.",
    "form.moneyTitle": "Money limits",
    "form.decideTitle": "What the bots decide themselves",
    "form.decideNote": "Bot 2 decides which coins could pump; bot 3 measures how each coin swings and sets its own entry, stop and exit. There are no strategy numbers to set here.",
    "help.chain": "Three bots in a chain, not three separate bots: bot 1 screens every coin, bot 2 filters what it found, bot 3 trades what passes. One practice account for all three.",
    "help.perMinute": "How many times bot 1 looked at a coin in the last minute, re-looks included. Hundreds a minute is normal.",
    "help.green": "Green means bot 2 thinks the coin could pump right now. It is re-judged constantly, so it can be taken away again.",
    "help.record": "How many closed practice trades made money against how many lost.",
    "help.watching": "Green coins bot 3 is watching while it waits for its entry.",
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

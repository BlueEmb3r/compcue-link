// CompCue Link for Windows: the icon next to the clock.
//
// It is only the face of the helper. It starts compcue-link.exe (next to it in the package) without a window, keeps
// it running, and shows what the helper writes to status.json: waiting for League, connected, or a code to confirm.
// It never talks to the League client or to the site itself.
//
// The site's "Connect this PC" button opens  compcue-link:setup?key=<one-time key>  which starts this program with
// that address. It asks the player first, then lets the helper trade the key for this computer's token.
//
// Plain C# 5 on the .NET Framework every Windows 10 and 11 already has, so the package carries no runtime:
//   csc /target:winexe /out:CompCueLink.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.IO.Compression.FileSystem.dll /r:System.IO.Compression.dll CompCueLink.cs
//
// Two ways to get it: the Microsoft Store package (the Store updates it, Windows starts it, the site's button reaches
// it through the package) and CompCueLink-windows.zip from the GitHub release (extract it anywhere you can write).
// The zip copy does what the package does for itself: it registers the compcue-link: button for this user, starts with
// Windows (the menu switches it off), and updates itself from the release when League is closed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using Microsoft.Win32;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("CompCue Link")]
[assembly: AssemblyProduct("CompCue Link")]
[assembly: AssemblyCompany("CompCue")]

static class Words
{
    static readonly bool Es = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "es";
    public static string T(string en, string es) { return Es ? es : en; }
}

static class Paths
{
    public const string DefaultSite = "https://compcue.aflince.com";
    public static readonly string Dir = Environment.GetEnvironmentVariable("COMPCUE_DIR")
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "CompCue");
    public static readonly string Helper = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "compcue-link.exe");
    // a development site on this same computer is the only other site a link may name
    public static readonly Regex Loopback = new Regex(@"^http://(127\.0\.0\.1|localhost):\d{2,5}$");
    public static readonly Regex Key = new Regex(@"^[A-Za-z0-9_-]{16,80}$");
    public static readonly Regex Code = new Regex(@"^[A-Z0-9]{3}-[A-Z0-9]{4}$");

    public const string Releases = "https://github.com/BlueEmb3r/compcue-link/releases";
    public static readonly string Exe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "CompCueLink.exe");
    /// True inside the Microsoft Store package: the Store installs, starts and updates that copy.
    public static readonly bool Packaged = AppDomain.CurrentDomain.BaseDirectory.IndexOf("\\WindowsApps\\", StringComparison.OrdinalIgnoreCase) >= 0;
    public static readonly Regex Version = new Regex(@"^\d+\.\d+\.\d+$");

    public static bool SiteOk(string s) { return s != null && (s.StartsWith("https://") || Loopback.IsMatch(s)); }
}

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        string key = null, site = null;
        foreach (string a in args)
        {
            if (!a.StartsWith("compcue-link:", StringComparison.OrdinalIgnoreCase)) continue;
            Match k = Regex.Match(a, @"[?&]key=([^&]+)");
            Match s = Regex.Match(a, @"[?&]site=([^&]+)");
            if (k.Success && Paths.Key.IsMatch(k.Groups[1].Value)) key = k.Groups[1].Value;
            if (s.Success) { string v = Uri.UnescapeDataString(s.Groups[1].Value); if (Paths.Loopback.IsMatch(v)) site = v; }
        }
        if (!File.Exists(Paths.Helper))
        {
            // started from inside the zip (Windows opens it as a folder): the helper is not next to it
            MessageBox.Show(Words.T("Extract the whole zip first (right-click, Extract All), then open CompCueLink.exe from the new folder.",
                                    "Primero extrae todo el zip (clic derecho, Extraer todo) y luego abre CompCueLink.exe desde la carpeta nueva."),
                "CompCue Link", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
        string said = key != null ? Connect(key, site) : null;

        // a copy that was just replaced by an update waits for the old one to let go of the icon
        bool afterUpdate = Array.IndexOf(args, "--after-update") >= 0;
        using (Mutex one = new Mutex(false, "Local\\CompCueLink.Tray"))
        {
            bool got;
            try { got = one.WaitOne(afterUpdate ? 15000 : 0); } catch (AbandonedMutexException) { got = true; }
            if (!got)
            {
                // the copy that is already running shows the result in its own menu
                if (said != null) MessageBox.Show(said, "CompCue Link", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            Application.Run(new Tray(site, said));
            try { one.ReleaseMutex(); } catch { }
        }
        return 0;
    }

    /// The site's button: ask, then let the helper trade the one-time key for this computer's token.
    static string Connect(string key, string site)
    {
        if (site == null)
        {
            DialogResult yes = MessageBox.Show(
                Words.T("Connect this PC to the CompCue account open in your browser?\n\nSay yes only if you just pressed \"Connect this PC\" on compcue.aflince.com yourself. That account will see your lobby and champ select.",
                        "¿Conectar esta PC a la cuenta de CompCue abierta en tu navegador?\n\nDi que sí solo si acabas de presionar \"Conectar esta PC\" en compcue.aflince.com. Esa cuenta verá tu lobby y tu champ select."),
                "CompCue Link", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (yes != DialogResult.Yes) return null;
        }
        try
        {
            ProcessStartInfo i = new ProcessStartInfo(Paths.Helper, (site != null ? "--site " + site + " " : "") + "--setup " + key + " --claim-only");
            i.UseShellExecute = false; i.CreateNoWindow = true;
            i.EnvironmentVariables["COMPCUE_NO_BROWSER"] = "1";
            using (Process p = Process.Start(i))
            {
                if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } return Words.T("CompCue did not answer. Try again in a moment.", "CompCue no respondió. Intenta de nuevo en un momento."); }
                return p.ExitCode == 0
                    ? Words.T("This PC is connected to your CompCue account.", "Esta PC quedó conectada a tu cuenta de CompCue.")
                    : Words.T("That button ran out. Press \"Connect this PC\" on the CompCue page again.", "Ese botón ya venció. Presiona \"Conectar esta PC\" otra vez en la página de CompCue.");
            }
        }
        catch { return Words.T("CompCue Link could not start.", "CompCue Link no pudo iniciar."); }
    }
}

sealed class Tray : ApplicationContext
{
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

    readonly NotifyIcon icon = new NotifyIcon();
    readonly ContextMenuStrip menu = new ContextMenuStrip();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly string site;
    Process helper;
    bool quitting;
    int restarts;
    DateTime startAgainAt = DateTime.MinValue;
    string state = "starting", code, statusSite, version, update;
    IntPtr lastIcon = IntPtr.Zero;

    public Tray(string site, string firstWords)
    {
        this.site = site;
        icon.ContextMenuStrip = menu;
        icon.Visible = true;
        icon.MouseUp += delegate(object s, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            MethodInfo show = typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic);
            if (show != null) show.Invoke(icon, null);
        };
        menu.Opening += delegate { ReadStatus(); Rebuild(); };
        StopStrays();
        if (!Paths.Packaged) { CleanOld(); RegisterProtocol(); FirstRunStartup(); }
        Render();
        StartHelper();
        timer.Interval = 2000;
        timer.Tick += delegate { Tick(); };
        timer.Start();
        icon.ShowBalloonTip(6000, "CompCue Link",
            firstWords ?? Words.T("Running here, next to the clock. Open League and go to the CompCue page.", "Está aquí, junto al reloj. Abre League y ve a la página de CompCue."),
            ToolTipIcon.None);
    }

    // ---- the helper

    /// A helper left behind by a copy of this program that was ended the hard way.
    void StopStrays()
    {
        try
        {
            foreach (Process p in Process.GetProcessesByName("compcue-link"))
            {
                try { if (string.Equals(p.MainModule.FileName, Paths.Helper, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); } } catch { }
            }
        }
        catch { }
    }

    void StartHelper()
    {
        try
        {
            ProcessStartInfo i = new ProcessStartInfo(Paths.Helper, site != null ? "--site " + site : "");
            i.UseShellExecute = false; i.CreateNoWindow = true;
            // this program opens the pairing page itself, once (see Tick): not at every start of Windows
            i.EnvironmentVariables["COMPCUE_NO_BROWSER"] = "1";
            helper = Process.Start(i);
        }
        catch { helper = null; state = "broken"; Render(); }
    }

    void Tick()
    {
        if (quitting) return;
        if (helper != null && helper.HasExited)
        {
            helper.Dispose(); helper = null;
            restarts++;
            // a helper that keeps stopping is started again more and more slowly, at most once a minute
            startAgainAt = DateTime.UtcNow.AddSeconds(Math.Min(60, 2 * restarts));
        }
        if (helper == null && state != "broken" && DateTime.UtcNow >= startAgainAt) StartHelper();
        ReadStatus();
        MaybeUpdate();
    }

    // ---- the zip copy: what the Store package gets from Windows and the Store, done here

    const string RunKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

    /// The files an update replaced are renamed to .old (a running program can be renamed, not overwritten); remove them.
    static void CleanOld()
    {
        foreach (string f in new string[] { "CompCueLink.old.exe", "compcue-link.old.exe" })
            try { File.Delete(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, f)); } catch { }
    }

    /// The site's "Connect this PC" button opens compcue-link:...; for this user it starts this program (the package does it for itself).
    static void RegisterProtocol()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey("Software\\Classes\\compcue-link"))
            {
                k.SetValue("", "URL:CompCue Link"); k.SetValue("URL Protocol", "");
                using (RegistryKey c = k.CreateSubKey("shell\\open\\command")) c.SetValue("", "\"" + Paths.Exe + "\" \"%1\"");
            }
        }
        catch { }
    }

    static bool StartsWithWindows()
    {
        try { using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey)) return k != null && k.GetValue("CompCueLink") != null; } catch { return false; }
    }
    static void SetStartsWithWindows(bool on)
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) k.SetValue("CompCueLink", "\"" + Paths.Exe + "\""); else k.DeleteValue("CompCueLink", false);
            }
        }
        catch { }
    }
    /// The first time it runs it starts with Windows (the menu switches it off); the choice is remembered after that.
    static void FirstRunStartup()
    {
        string mark = Path.Combine(Paths.Dir, "startup-set");
        try
        {
            Directory.CreateDirectory(Paths.Dir);
            if (!File.Exists(mark)) { File.WriteAllText(mark, ""); SetStartsWithWindows(true); }
            else if (StartsWithWindows()) SetStartsWithWindows(true); // keeps the path right if the folder moved
        }
        catch { }
    }

    bool updating;
    DateTime updateAfter = DateTime.MinValue;

    /// A newer release, only when League is closed or nothing is going on (never during a queue, champ select or game).
    /// The download comes from this project's own GitHub release, is checked against the release's SHA256SUMS, and only
    /// the two program files are taken out of it.
    void MaybeUpdate()
    {
        if (Paths.Packaged || quitting || updating || update == null || !Paths.Version.IsMatch(update)) return;
        if (state != "waiting" && state != "pairing" && state != "offline") return;
        if (DateTime.UtcNow < updateAfter) return;
        updating = true;
        string want = update;
        Thread t = new Thread(delegate()
        {
            bool ok = false;
            try { ok = Update(want); } catch { }
            updating = false;
            if (!ok) updateAfter = DateTime.UtcNow.AddMinutes(30);
        });
        t.IsBackground = true; t.Start();
    }

    bool Update(string v)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
        string baseUrl = Paths.Releases + "/download/v" + v + "/";
        string tmp = Path.Combine(Path.GetTempPath(), "CompCueLink-update-" + v);
        if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
        Directory.CreateDirectory(tmp);
        string zip = Path.Combine(tmp, "CompCueLink-windows.zip");
        string want = null;
        using (WebClient w = new WebClient())
        {
            foreach (string line in w.DownloadString(baseUrl + "SHA256SUMS").Split('\n'))
            {
                string[] p = line.Trim().Split(new char[] { ' ', '*' }, StringSplitOptions.RemoveEmptyEntries);
                if (p.Length == 2 && p[1] == "CompCueLink-windows.zip" && Regex.IsMatch(p[0], "^[0-9a-fA-F]{64}$")) want = p[0].ToLowerInvariant();
            }
            if (want == null) return false;
            w.DownloadFile(baseUrl + "CompCueLink-windows.zip", zip);
        }
        string got;
        using (SHA256 sha = SHA256.Create()) using (FileStream f = File.OpenRead(zip))
            got = BitConverter.ToString(sha.ComputeHash(f)).Replace("-", "").ToLowerInvariant();
        if (got != want) return false;

        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string[] names = new string[] { "CompCueLink.exe", "compcue-link.exe" };
        using (ZipArchive z = ZipFile.OpenRead(zip))
        {
            foreach (string n in names)
            {
                ZipArchiveEntry e = z.GetEntry(n);
                if (e == null) return false;
                e.ExtractToFile(Path.Combine(tmp, n), true);
            }
        }
        // the helper first (stopped), then the tray program: rename what is there, put the new files in
        quitting = true;
        try { if (helper != null && !helper.HasExited) { helper.Kill(); helper.WaitForExit(3000); } } catch { }
        StopStrays();
        foreach (string n in names)
        {
            string live = Path.Combine(dir, n), old = Path.Combine(dir, Path.GetFileNameWithoutExtension(n) + ".old.exe");
            try { File.Delete(old); } catch { }
            File.Move(live, old);
            File.Move(Path.Combine(tmp, n), live);
        }
        try { Directory.Delete(tmp, true); } catch { }
        ProcessStartInfo i = new ProcessStartInfo(Paths.Exe, "--after-update"); i.UseShellExecute = false;
        Process.Start(i);
        icon.Visible = false;
        Application.Exit();
        return true;
    }

    void ReadStatus()
    {
        try
        {
            string text = File.ReadAllText(Path.Combine(Paths.Dir, "status.json"));
            Dictionary<string, object> j = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
            string s = Str(j, "state"), c = Str(j, "code"), u = Str(j, "update");
            statusSite = Str(j, "site"); version = Str(j, "version");
            if (s == null) return;
            if (s == "connected") restarts = 0;
            if (c != null && !Paths.Code.IsMatch(c)) c = null;
            bool changed = s != state || c != code || u != update;
            bool newCode = s == "pairing" && c != null && c != code;
            state = s; code = c; update = u;
            if (changed) Render();
            if (newCode) Welcome();
        }
        catch { }
    }
    static string Str(Dictionary<string, object> j, string k) { object v; return j.TryGetValue(k, out v) ? v as string : null; }

    /// The first time ever there is a code to confirm, open the page for it. After that only say so by the clock.
    void Welcome()
    {
        string mark = Path.Combine(Paths.Dir, "welcomed");
        if (!File.Exists(mark))
        {
            try { File.WriteAllText(mark, ""); } catch { }
            OpenPair();
        }
        else
        {
            icon.ShowBalloonTip(8000, "CompCue Link", Words.T("Not connected to your account yet. Click the icon, then \"Connect this PC\".", "Aún no está conectada a tu cuenta. Haz clic en el ícono y luego en \"Conectar esta PC\"."), ToolTipIcon.None);
        }
    }

    // ---- what the player sees

    string Line()
    {
        switch (state)
        {
            case "connected": return Words.T("Connected to CompCue", "Conectado a CompCue");
            case "connecting": return Words.T("League is open. Connecting…", "League está abierto. Conectando…");
            case "waiting": return Words.T("Ready. Waiting for League to open", "Listo. Esperando a que abras League");
            case "pairing": return code != null ? Words.T("Confirm code " + code + " in your browser", "Confirma el código " + code + " en tu navegador") : Words.T("Not connected to your account yet", "Aún no está conectada a tu cuenta");
            case "offline": return Words.T("Can't reach CompCue. Trying again", "No se puede llegar a CompCue. Intentando de nuevo");
            case "update": return Paths.Packaged ? Words.T("This version is too old. Update it in the Microsoft Store", "Esta versión es muy vieja. Actualízala en Microsoft Store")
                : Words.T("This version is too old. Updating…", "Esta versión es muy vieja. Actualizando…");
            case "broken": return Words.T("CompCue Link could not start", "CompCue Link no pudo iniciar");
            default: return Words.T("Starting…", "Iniciando…");
        }
    }

    void Render()
    {
        Color dot = state == "connected" ? Color.FromArgb(46, 204, 113)
            : state == "pairing" || state == "offline" || state == "broken" || state == "update" ? Color.FromArgb(231, 76, 60)
            : Color.FromArgb(200, 170, 110);
        using (Bitmap b = new Bitmap(32, 32))
        {
            using (Graphics g = Graphics.FromImage(b))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (SolidBrush back = new SolidBrush(Color.FromArgb(1, 10, 19))) g.FillEllipse(back, 0, 0, 31, 31);
                // the mark: a gold C
                using (Pen ring = new Pen(Color.FromArgb(200, 170, 110), 4.5f)) { ring.StartCap = LineCap.Round; ring.EndCap = LineCap.Round; g.DrawArc(ring, 7, 7, 17, 17, 50, 260); }
                using (SolidBrush edge = new SolidBrush(Color.FromArgb(1, 10, 19))) g.FillEllipse(edge, 17, 17, 15, 15);
                using (SolidBrush fill = new SolidBrush(dot)) g.FillEllipse(fill, 19, 19, 11, 11);
            }
            IntPtr h = b.GetHicon();
            icon.Icon = Icon.FromHandle(h);
            if (lastIcon != IntPtr.Zero) DestroyIcon(lastIcon);
            lastIcon = h;
        }
        string tip = "CompCue Link: " + Line();
        icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
    }

    void Rebuild()
    {
        menu.Items.Clear();
        ToolStripMenuItem head = new ToolStripMenuItem(Line()); head.Enabled = false; menu.Items.Add(head);
        menu.Items.Add(new ToolStripSeparator());
        if (state == "pairing") menu.Items.Add(Item(Words.T("Connect this PC…", "Conectar esta PC…"), delegate { OpenPair(); }));
        menu.Items.Add(Item(Words.T("Open CompCue", "Abrir CompCue"), delegate { Open(Site() + "/#/live"); }));
        menu.Items.Add(new ToolStripSeparator());
        if (Paths.Packaged) menu.Items.Add(Item(Words.T("Start with Windows…", "Iniciar con Windows…"), delegate { Open("ms-settings:startupapps"); }));
        else
        {
            ToolStripMenuItem on = Item(Words.T("Start with Windows", "Iniciar con Windows"), delegate { SetStartsWithWindows(!StartsWithWindows()); });
            on.Checked = StartsWithWindows();
            menu.Items.Add(on);
        }
        menu.Items.Add(Item(Words.T("Show log", "Ver registro"), delegate { ShowLog(); }));
        if (update != null && Paths.Packaged)
            menu.Items.Add(Item(Words.T("Version " + update + " is out: get it in Microsoft Store", "Versión " + update + " disponible: obtenla en Microsoft Store"), delegate { Open("ms-windows-store://pdp/?productid=9P94STX43TBX"); }));
        else if (update != null)
            menu.Items.Add(Item(Words.T("Version " + update + " is out: installs when League is closed", "Versión " + update + " disponible: se instala cuando League esté cerrado"), delegate { Open(Paths.Releases + "/latest"); }));
        if (version != null)
        {
            ToolStripMenuItem v = new ToolStripMenuItem(Words.T("Version ", "Versión ") + version); v.Enabled = false; menu.Items.Add(v);
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(Item(Words.T("Quit CompCue Link", "Salir de CompCue Link"), delegate { Quit(); }));
    }
    static ToolStripMenuItem Item(string text, EventHandler on) { ToolStripMenuItem i = new ToolStripMenuItem(text); i.Click += on; return i; }

    // The site address comes from the helper's own status (the site it was started with), https only.
    string Site() { return Paths.SiteOk(statusSite) ? statusSite : Paths.DefaultSite; }
    static void Open(string what) { try { Process.Start(what); } catch { } }
    void OpenPair() { Open(code != null ? Site() + "/#/link?code=" + code : Site() + "/#/link"); }
    void ShowLog()
    {
        // notepad is started from here (not through the shell) so that it sees the same files this program sees
        try { ProcessStartInfo i = new ProcessStartInfo("notepad.exe", "\"" + Path.Combine(Paths.Dir, "link.log") + "\""); i.UseShellExecute = false; Process.Start(i); } catch { }
    }

    void Quit()
    {
        quitting = true;
        timer.Stop();
        try { if (helper != null && !helper.HasExited) helper.Kill(); } catch { }
        try { File.WriteAllText(Path.Combine(Paths.Dir, "status.json"), "{\"state\":\"stopped\"}"); } catch { }
        icon.Visible = false;
        ExitThread();
    }
}

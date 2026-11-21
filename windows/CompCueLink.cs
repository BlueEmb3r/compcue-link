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
//   csc /target:winexe /out:CompCueLink.exe /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll CompCueLink.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
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
        string said = key != null ? Connect(key, site) : null;

        bool first;
        using (Mutex one = new Mutex(true, "Local\\CompCueLink.Tray", out first))
        {
            if (!first)
            {
                // the copy that is already running shows the result in its own menu
                if (said != null) MessageBox.Show(said, "CompCue Link", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 0;
            }
            Application.Run(new Tray(site, said));
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
            case "update": return Words.T("This version is too old. Update it in the Microsoft Store", "Esta versión es muy vieja. Actualízala en Microsoft Store");
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
        menu.Items.Add(Item(Words.T("Start with Windows…", "Iniciar con Windows…"), delegate { Open("ms-settings:startupapps"); }));
        menu.Items.Add(Item(Words.T("Show log", "Ver registro"), delegate { ShowLog(); }));
        if (update != null)
            menu.Items.Add(Item(Words.T("Version " + update + " is out: get it in Microsoft Store", "Versión " + update + " disponible: obtenla en Microsoft Store"), delegate { Open("ms-windows-store://pdp/?productid=9P94STX43TBX"); }));
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

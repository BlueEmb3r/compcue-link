// CompCue Link for Windows: the icon next to the clock. One file to run: CompCueLink.exe.
//
// It is only the face of the helper. It starts compcue-link.exe (the small program that reads the League client)
// without a window, keeps it running, and shows what the helper writes to status.json: waiting for League, connected,
// or a code to confirm. It never talks to the League client or to the site itself.
//
// The site's "Connect this PC" button opens  compcue-link:setup?key=<one-time key>  which starts this program with
// that address. It asks the player first, then lets the helper trade the key for this computer's token.
//
// Two ways to get it:
// - the Microsoft Store package: the Store installs and updates it, Windows starts it, and the helper is a file
//   next to this program in the package.
// - CompCueLink.exe from the GitHub release: the helper is inside this file. Opened from anywhere (the Downloads
//   folder), it puts itself in %LOCALAPPDATA%\CompCue, starts from there, and from then on does what the package
//   gets from Windows: the compcue-link: button for this user, a Start menu entry, starting with Windows (the menu
//   switches it off), and updates from the release when League is closed. The menu also removes it again.
//
// Plain C# 5 on the .NET Framework every Windows 10 and 11 already has, so nothing else is needed:
//   csc /target:winexe /out:CompCueLink.exe /resource:compcue-link.exe,compcue-link.exe /r:System.Windows.Forms.dll
//       /r:System.Drawing.dll /r:System.Web.Extensions.dll CompCueLink.cs Version.cs
// Version.cs is one line the build writes: [assembly: System.Reflection.AssemblyVersion("0.5.0.0")]
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
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
    /// Where an update is downloaded from: this project's releases, fixed. Only a server on this same computer can stand
    /// in for it (the build's own test does), never another address.
    public static readonly string ReleaseFiles = Loopback.IsMatch(Environment.GetEnvironmentVariable("COMPCUE_RELEASES") ?? "")
        ? Environment.GetEnvironmentVariable("COMPCUE_RELEASES") : Releases + "/download";
    public static readonly string Exe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "CompCueLink.exe");
    /// Where the copy from the release lives once it has been opened once.
    public static readonly string InstallDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CompCue");
    public static readonly string InstalledExe = Path.Combine(InstallDir, "CompCueLink.exe");
    public static readonly bool Installed = string.Equals(AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'), InstallDir, StringComparison.OrdinalIgnoreCase);
    public static readonly string Shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "CompCue Link.lnk");
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
        if (!Paths.Packaged && Array.IndexOf(args, "--remove") >= 0) { Setup.Remove(); return 0; }
        // the copy from the release, opened from wherever it was downloaded: put it in its own folder and start it there
        if (!Paths.Packaged && !Paths.Installed) return Setup.Install(args);
        if (!Paths.Packaged) Setup.EnsureHelper();
        if (!File.Exists(Paths.Helper))
        {
            MessageBox.Show(Words.T("CompCue Link could not start: its helper is missing. Download CompCueLink.exe again.",
                                    "CompCue Link no pudo iniciar: falta su ayudante. Descarga CompCueLink.exe otra vez."),
                "CompCue Link", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                else if (key == null && !afterUpdate)
                    MessageBox.Show(Words.T("CompCue Link is already running. Its icon is next to the clock (click the small arrow there if you do not see it).",
                                            "CompCue Link ya está abierto. Su ícono está junto al reloj (haz clic en la flechita si no lo ves)."),
                        "CompCue Link", MessageBoxButtons.OK, MessageBoxIcon.Information);
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

/// The copy from the release looks after itself: where it lives, and the helper it carries inside.
static class Setup
{
    /// Stop the tray program and helper that run from this folder (never this process).
    public static void StopAt(string dir)
    {
        int me = Process.GetCurrentProcess().Id;
        foreach (string name in new string[] { "CompCueLink", "compcue-link" })
        {
            try
            {
                foreach (Process p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        if (p.Id != me && p.MainModule.FileName.StartsWith(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(5000); }
                    }
                    catch { }
                }
            }
            catch { }
        }
    }

    static Version VersionOf(string exe) { try { return AssemblyName.GetAssemblyName(exe).Version; } catch { return null; } }

    /// Opened from the Downloads folder (or anywhere): copy this program to its own folder, unless a newer one is
    /// already there, and start that copy. Written as a new file, so it is this computer's own file from then on.
    public static int Install(string[] args)
    {
        try
        {
            Directory.CreateDirectory(Paths.InstallDir);
            string mine = Assembly.GetExecutingAssembly().Location, target = Paths.InstalledExe;
            Version here = VersionOf(mine), there = File.Exists(target) ? VersionOf(target) : null;
            if (!File.Exists(target) || there == null || (here != null && there < here))
            {
                StopAt(Paths.InstallDir);
                string old = Path.Combine(Paths.InstallDir, "CompCueLink.old.exe");
                if (File.Exists(target)) { try { File.Delete(old); } catch { } File.Move(target, old); }
                File.WriteAllBytes(target, File.ReadAllBytes(mine));
            }
            List<string> quoted = new List<string>();
            foreach (string a in args) quoted.Add("\"" + a.Replace("\"", "") + "\"");
            ProcessStartInfo i = new ProcessStartInfo(target, string.Join(" ", quoted.ToArray())); i.UseShellExecute = false;
            Process.Start(i).Dispose();
            return 0;
        }
        catch (Exception e)
        {
            MessageBox.Show(Words.T("CompCue Link could not set itself up: ", "CompCue Link no se pudo instalar: ") + e.Message, "CompCue Link", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
    }

    /// The helper this program carries: written next to it when it is missing or not the same one.
    public static void EnsureHelper()
    {
        try
        {
            using (Stream r = Assembly.GetExecutingAssembly().GetManifestResourceStream("compcue-link.exe"))
            {
                if (r == null) return; // built without it: the helper is a file next to this program
                byte[] want = new byte[r.Length];
                int at = 0, n;
                while (at < want.Length && (n = r.Read(want, at, want.Length - at)) > 0) at += n;
                if (File.Exists(Paths.Helper))
                {
                    byte[] have = File.ReadAllBytes(Paths.Helper);
                    bool same = have.Length == want.Length;
                    for (int k = 0; same && k < have.Length; k++) same = have[k] == want[k];
                    if (same) return;
                    // a helper from the version before is still running until its tray program is replaced: stop it
                    foreach (Process p in Process.GetProcessesByName("compcue-link"))
                        try { if (string.Equals(p.MainModule.FileName, Paths.Helper, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(5000); } } catch { }
                }
                File.WriteAllBytes(Paths.Helper, want);
            }
        }
        catch { }
    }

    /// Everything the copy from the release put on this computer, gone: `CompCueLink.exe --remove` or the menu.
    public static void Remove()
    {
        StopAt(Paths.InstallDir);
        try { using (RegistryKey k = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", true)) if (k != null) k.DeleteValue("CompCueLink", false); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree("Software\\Classes\\compcue-link", false); } catch { }
        try { File.Delete(Paths.Shortcut); } catch { }
        try { Directory.Delete(Paths.Dir, true); } catch { }
        if (!Paths.InstallDir.EndsWith("\\CompCue", StringComparison.OrdinalIgnoreCase) || !Directory.Exists(Paths.InstallDir)) return;
        // a running program cannot delete itself: a hidden command removes the folder a moment after this one has gone
        try
        {
            ProcessStartInfo i = new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + Paths.InstallDir + "\"");
            i.UseShellExecute = false; i.CreateNoWindow = true; i.WorkingDirectory = Path.GetTempPath();
            Process.Start(i).Dispose();
        }
        catch { }
    }

    /// A Start menu entry, so it can be found and started like any program.
    public static void StartMenu()
    {
        try
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            object link = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { Paths.Shortcut });
            link.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { Paths.Exe });
            link.GetType().InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { "CompCue Link" });
            link.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
        }
        catch { }
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
    int statusPid;
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
            if (!File.Exists(mark)) { File.WriteAllText(mark, ""); SetStartsWithWindows(true); Setup.StartMenu(); }
            else if (StartsWithWindows()) SetStartsWithWindows(true); // keeps the path right if the folder moved
        }
        catch { }
    }

    // ---- updates for the zip copy
    // The download and its check run on a background thread; the swap itself runs on the window thread (Tick), so the
    // icon, the helper and the files are only ever touched from one place. If any step fails nothing is left half done:
    // the files that were there are put back, the helper starts again, and it is tried again in 30 minutes.

    bool updating;
    volatile string staged;      // folder with the two checked program files, ready to go in
    DateTime updateAfter = DateTime.MinValue;
    // the helper is inside the tray program: the new copy writes its own helper when it starts
    static readonly string[] Programs = new string[] { "CompCueLink.exe" };

    static void Note(string line)
    {
        try { File.AppendAllText(Path.Combine(Paths.Dir, "link.log"), DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " [tray] " + line + "\n"); } catch { }
    }

    /// A newer release, only when League is closed (never during a queue, champ select or game).
    /// The download comes from this project's own GitHub release and is checked against the release's SHA256SUMS.
    void MaybeUpdate()
    {
        if (Paths.Packaged || quitting || update == null || !Paths.Version.IsMatch(update)) return;
        // only what the helper this program started says now: a status file left by an earlier copy is not a reason
        try { if (helper == null || helper.HasExited || statusPid != helper.Id) return; } catch { return; }
        if (state != "waiting" && state != "pairing" && state != "offline" && state != "update") return;
        if (staged != null) { string dir = staged; staged = null; Swap(dir); return; }
        if (updating || DateTime.UtcNow < updateAfter) return;
        updating = true;
        string want = update;
        Thread t = new Thread(delegate()
        {
            string got = null;
            try { got = Fetch(want); } catch (Exception e) { Note("Update to " + want + " not downloaded: " + e.Message); }
            if (got == null) updateAfter = DateTime.UtcNow.AddMinutes(30);
            staged = got;
            updating = false;
        });
        t.IsBackground = true; t.Start();
    }

    /// Download the release's CompCueLink.exe and check it against the release's SHA256SUMS. Returns its folder, or null.
    static string Fetch(string v)
    {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
        string baseUrl = Paths.ReleaseFiles + "/v" + v + "/";
        string tmp = Path.Combine(Path.GetTempPath(), "CompCueLink-update-" + v);
        if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
        Directory.CreateDirectory(tmp);
        string file = Path.Combine(tmp, "CompCueLink.exe");
        string want = null;
        using (WebClient w = new WebClient())
        {
            foreach (string line in w.DownloadString(baseUrl + "SHA256SUMS").Split('\n'))
            {
                string[] p = line.Trim().Split(new char[] { ' ', '*' }, StringSplitOptions.RemoveEmptyEntries);
                if (p.Length == 2 && p[1] == "CompCueLink.exe" && Regex.IsMatch(p[0], "^[0-9a-fA-F]{64}$")) want = p[0].ToLowerInvariant();
            }
            if (want == null) { Note("Update to " + v + ": the release lists no CompCueLink.exe."); return null; }
            w.DownloadFile(baseUrl + "CompCueLink.exe", file);
        }
        string got;
        using (SHA256 sha = SHA256.Create()) using (FileStream f = File.OpenRead(file))
            got = BitConverter.ToString(sha.ComputeHash(f)).Replace("-", "").ToLowerInvariant();
        if (got != want) { Note("Update to " + v + ": the download does not match the release's checksum. Not installed."); return null; }
        return tmp;
    }

    /// Put the checked file in and start the new copy. A running program can be renamed but not overwritten, so what
    /// is there becomes .old (removed at the next start). On any failure the old file goes back.
    void Swap(string from)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        List<string> moved = new List<string>();
        timer.Stop();
        try { if (helper != null && !helper.HasExited) { helper.Kill(); helper.WaitForExit(5000); } } catch { }
        if (helper != null) { helper.Dispose(); helper = null; }
        StopStrays();
        try
        {
            foreach (string n in Programs)
            {
                string live = Path.Combine(dir, n), old = Path.Combine(dir, Path.GetFileNameWithoutExtension(n) + ".old.exe");
                if (File.Exists(old)) File.Delete(old);
                File.Move(live, old);
                moved.Add(n);
                File.Move(Path.Combine(from, n), live);
            }
            ProcessStartInfo i = new ProcessStartInfo(Paths.Exe, "--after-update"); i.UseShellExecute = false;
            Process.Start(i).Dispose();
        }
        catch (Exception e)
        {
            Note("Update not installed (" + e.Message + "). Keeping this version.");
            foreach (string n in moved)
            {
                string live = Path.Combine(dir, n), old = Path.Combine(dir, Path.GetFileNameWithoutExtension(n) + ".old.exe");
                try { if (File.Exists(live)) File.Delete(live); File.Move(old, live); } catch { }
            }
            updateAfter = DateTime.UtcNow.AddMinutes(30);
            timer.Start(); // Tick starts the helper again
            return;
        }
        Note("Updated to " + update + ". Starting the new version.");
        try { Directory.Delete(from, true); } catch { }
        quitting = true;
        icon.Visible = false;
        ExitThread();
    }

    void ReadStatus()
    {
        try
        {
            string text = File.ReadAllText(Path.Combine(Paths.Dir, "status.json"));
            Dictionary<string, object> j = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(text);
            string s = Str(j, "state"), c = Str(j, "code"), u = Str(j, "update");
            statusSite = Str(j, "site"); version = Str(j, "version");
            object pid; statusPid = j.TryGetValue("pid", out pid) && pid is int ? (int)pid : 0;
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
        if (!Paths.Packaged) menu.Items.Add(Item(Words.T("Remove from this PC…", "Quitar de esta PC…"), delegate { Uninstall(); }));
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

    /// The copy from the release removes itself: no start with Windows, no button, no Start menu entry, no files.
    void Uninstall()
    {
        DialogResult yes = MessageBox.Show(
            Words.T("Remove CompCue Link from this PC?\n\nIt stops, no longer starts with Windows, and its files and this PC's connection are deleted. You can also remove this PC on the CompCue page under \"Connected computers\".",
                    "¿Quitar CompCue Link de esta PC?\n\nSe cierra, deja de iniciar con Windows y se borran sus archivos y la conexión de esta PC. También puedes quitar esta PC en la página de CompCue, en \"Computadoras conectadas\"."),
            "CompCue Link", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (yes != DialogResult.Yes) return;
        quitting = true;
        timer.Stop();
        try { if (helper != null && !helper.HasExited) { helper.Kill(); helper.WaitForExit(5000); } } catch { }
        StopStrays();
        Setup.Remove();
        icon.Visible = false;
        ExitThread();
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

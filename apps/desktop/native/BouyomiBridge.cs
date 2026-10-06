// Interoperability wrapper. The user supplies BouyomiChan.exe; none of its code is bundled.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Xml;

public static class BouyomiBridge {
    static Assembly assembly;
    static object processor;
    static string directory;
    static object Invoke(object target, string name, params object[] args) {
        foreach (MethodInfo method in target.GetType().GetMethods()) {
            if (method.Name == name && method.GetParameters().Length == args.Length) return method.Invoke(target, args);
        }
        throw new MissingMethodException(name);
    }
    static object Field(object target, string name) { return target.GetType().GetField(name).GetValue(target); }
    static string Setting(XmlDocument doc, string name, string fallback) {
        XmlNode node = doc.SelectSingleNode("/Settings/" + name); return node == null ? fallback : node.InnerText;
    }
    static void Load() {
        assembly = Assembly.LoadFrom(Path.Combine(directory, "BouyomiChan.exe"));
        // Only call stateless conversion APIs; the original constructor starts UI/audio threads.
        processor = FormatterServices.GetUninitializedObject(assembly.GetType("FNF.Utility.BouyomiChan", true));
        foreach (string stage in new string[] { "Pre", "Tag", "Study", "Word", "Talk", "Post" }) {
            string suffix = stage == "Study" ? "Studies" : stage + "s";
            foreach (bool regex in new bool[] { false, true }) {
                object rules = Activator.CreateInstance(assembly.GetType("FNF.Utility.MultiReplacer" + (regex ? "Regex" : ""), true));
                string path = Path.Combine(directory, "Replace" + stage + (regex ? "Regex" : "") + ".dic");
                if (File.Exists(path)) Invoke(rules, "LoadRule", path);
                processor.GetType().GetField((regex ? "Regex" : "Replace") + suffix).SetValue(processor, rules);
            }
        }
    }
    static object Process(string text, bool tags, bool study) {
        StringBuilder value = new StringBuilder(text);
        value = (StringBuilder)Invoke(processor, "RegexPre", value, false);
        value = (StringBuilder)Invoke(processor, "ReplacePre", value, false);
        value = (StringBuilder)Invoke(processor, "ConvertToUnifiedText", value);
        object tagged = Activator.CreateInstance(assembly.GetType("FNF.Utility.BouyomiChan+TagString", true), new object[] { value.ToString() });
        if (tags) { tagged = Invoke(processor, "RegexTag", tagged); tagged = Invoke(processor, "ReplaceTag", tagged); }
        value = (StringBuilder)Field(tagged, "Text");
        if (study) { value = (StringBuilder)Invoke(processor, "RegexStudy", value, false); value = (StringBuilder)Invoke(processor, "ReplaceStudy", value, false); }
        value = (StringBuilder)Invoke(processor, "RegexWord", value, false);
        value = (StringBuilder)Invoke(processor, "ReplaceWord", value, false);
        // VOICEVOX accepts normal text, matching the native SAPI path. AquesTalk phonemes
        // and the MSIME/Talk/Post path must not be fed to VOICEVOX as ordinary Japanese.
        List<Dictionary<string, object>> generated = new List<Dictionary<string, object>>();
        foreach (object tag in (IEnumerable)Field(tagged, "Tags")) generated.Add(new Dictionary<string, object> { { "type", Field(tag, "Type").ToString() }, { "args", Field(tag, "Args") } });
        // Fixed Latin readings explicitly chosen in native word/education rules
        // retain priority over the application's Latin fallback.
        HashSet<string> readings = new HashSet<string>();
        string output = value.ToString();
        foreach (string stage in study ? new string[] { "Study", "Word" } : new string[] { "Word" }) {
            foreach (string suffix in new string[] { "", "Regex" }) {
                string path = Path.Combine(directory, "Replace" + stage + suffix + ".dic");
                if (!File.Exists(path)) continue;
                foreach (string line in File.ReadAllLines(path, Encoding.UTF8)) {
                    string[] fields = line.Split('\t');
                    if (fields.Length != 4 || !Regex.IsMatch(fields[3], "[a-zA-ZＡ-Ｚａ-ｚ]") || fields[3].IndexOf('$') >= 0) continue;
                    string reading = Invoke(processor, "ConvertToUnifiedText", new StringBuilder(fields[3])).ToString();
                    if (reading.Length > 0 && output.Contains(reading)) readings.Add(reading);
                }
            }
        }
        return new Dictionary<string, object> { { "text", output }, { "parts", Invoke(processor, "SplitToShortText", value) }, { "tags", generated }, { "readings", new List<string>(readings) } };
    }
    static object Learn(string type, string args, XmlDocument settings) {
        object rules = Field(processor, "ReplaceStudies"); string source, reading = "";
        if (type != "Study" && type != "Forget" && type != "Mute") throw new ArgumentException("教育の操作を確認してください");
        bool forget = type == "Forget", mute = type == "Mute";
        if (forget || mute) source = args.Trim();
        else {
            string[] pair = args.Split(new char[] { '=', '＝' }, 2);
            if (pair.Length != 2) throw new ArgumentException("教育の単語と読み方を確認してください");
            source = pair[0].Trim(); reading = pair[1].Trim();
        }
        source = Invoke(processor, "ConvertToUnifiedText", new StringBuilder(source)).ToString();
        reading = Invoke(processor, "ConvertToUnifiedText", new StringBuilder(reading)).ToString();
        if (source.Length == 0 || source.IndexOfAny(new char[] { '\t', '\r', '\n' }) >= 0 || reading.IndexOfAny(new char[] { '\t', '\r', '\n' }) >= 0) throw new ArgumentException("教育する単語を確認してください");
        if (!forget && (source.Length < Int32.Parse(Setting(settings, "StudySrcMin", "2")) || reading.Length > Int32.Parse(Setting(settings, "StudyDstMax", "15")))) throw new ArgumentException("教育の文字数制限を確認してください");
        if (!mute && source == reading) forget = true;
        string path = Path.Combine(directory, "ReplaceStudy.dic");
        if (File.Exists(path) && !File.Exists(path + ".before-damare")) File.Copy(path, path + ".before-damare", false);
        if (forget) Invoke(rules, "RemoveRule", source.Length, source);
        else {
            try { Invoke(rules, "RemoveRule", source.Length, source); } catch (TargetInvocationException) { }
            Type wordType = assembly.GetType("FNF.Utility.MultiReplacer+WordType", true);
            object kind = Enum.Parse(wordType, Regex.IsMatch(source, "^[a-zA-Z]+$") ? "English" : "Normal");
            Invoke(rules, "AddRule", source.Length, kind, source, reading);
        }
        Invoke(rules, "SaveRule", path);
        string format = mute ? "{0} を 無音にしました" : Setting(settings, forget ? "ForgetFormat" : "StudyFormat", forget ? "{0} を 忘れました" : "{0} わ {1} を 覚えました");
        return new Dictionary<string, object> { { "text", String.Format(format, source, reading) } };
    }
    public static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        JavaScriptSerializer json = new JavaScriptSerializer();
        try {
            directory = Path.GetFullPath(args[0]);
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs ev) {
                string path = Path.Combine(directory, "System", new AssemblyName(ev.Name).Name + ".dll"); return File.Exists(path) ? Assembly.LoadFrom(path) : null;
            };
            Dictionary<string, object> request = json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
            XmlDocument settings = new XmlDocument(); settings.XmlResolver = null;
            using (XmlReader reader = XmlReader.Create(Path.Combine(directory, "BouyomiChan.setting"), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit })) settings.Load(reader);
            Load();
            object result;
            if ((string)request["operation"] == "learn") result = Learn((string)request["type"], (string)request["args"], settings);
            else {
                string mode = (string)request["tagMode"];
                bool broadcast = mode == "on" || mode == "original" && Setting(settings, "BroadcasterMode", "false") == "true";
                bool enabled = broadcast && Setting(settings, "TagEnable", "true") == "true";
                bool education = request.ContainsKey("educationEnabled") && request["educationEnabled"] is bool && (bool)request["educationEnabled"];
                result = Process((string)request["text"], enabled, education || enabled && Setting(settings, "StudyTag", "true") == "true");
            }
            Console.Write(json.Serialize(result)); return 0;
        } catch (Exception error) {
            Exception cause = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
            Console.Write(json.Serialize(new Dictionary<string, object> { { "error", cause.Message } })); return 1;
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Xml;

// Exercise the production bridge against a small substitute dictionary API;
// the user's BouyomiChan assembly is never redistributed in CI.
public static class NativeEducationProbe {
    static void Check(bool value) { if (!value) throw new Exception("Native education boundary regression"); }
    static object Learn(string type, string args, XmlDocument settings, bool restore) {
        return typeof(BouyomiBridge).GetMethod("Learn", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { type, args, settings, restore });
    }
    static void Rejected(Action operation) {
        try { operation(); }
        catch (TargetInvocationException error) {
            if (error.InnerException is ArgumentException && error.InnerException.Message.Contains("30文字")) return;
            throw;
        }
        throw new Exception("Native education accepted more than 30 characters");
    }
    public static void Run() {
        string temporary = Path.Combine(Path.GetTempPath(), "nyan-education-" + Guid.NewGuid());
        Directory.CreateDirectory(temporary);
        try {
            FNF.Utility.MultiReplacer rules = new FNF.Utility.MultiReplacer();
            Type bridge = typeof(BouyomiBridge);
            bridge.GetField("assembly", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, typeof(FNF.Utility.MultiReplacer).Assembly);
            bridge.GetField("processor", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, new FNF.Utility.EducationProcessor(rules));
            bridge.GetField("directory", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, temporary);
            XmlDocument settings = new XmlDocument(); settings.LoadXml("<Settings><StudySrcMin>2</StudySrcMin><StudyDstMax>15</StudyDstMax></Settings>");
            Learn("Study", "✅=ちぇっく", settings, false); Check(rules.Values["✅"] == "ちぇっく");
            string reading = new string('よ', 30);
            Learn("Study", "✅=" + reading, settings, false); Check(rules.Values["✅"] == reading);
            Rejected(delegate { Learn("Study", "✅=" + reading + "よ", settings, false); }); Check(rules.Values["✅"] == reading);
            Rejected(delegate { Learn("Study", new string('語', 31) + "=よ", settings, false); });
            string astral = new StringBuilder().Insert(0, "😀", 30).ToString();
            Check(BouyomiBridge.EducationCharacterCount(astral) == 30);
            Learn("Study", astral + "=" + reading, settings, false); Check(rules.LastBucketLength == 60 && rules.Values[astral] == reading);
            Rejected(delegate { Learn("Study", astral + "😀=" + reading, settings, false); });
            string oldSource = new string('昔', 40), oldReading = new string('旧', 40);
            rules.AddRule(oldSource.Length, FNF.Utility.MultiReplacer.WordType.Normal, oldSource, oldReading);
            Learn("Study", "✅=" + oldReading, settings, true); Check(rules.Values["✅"] == oldReading);
            Learn("Forget", oldSource, settings, false); Check(!rules.Values.ContainsKey(oldSource));
            Learn("Mute", "✅", settings, false); Check(rules.Values["✅"] == "");
            Learn("Forget", "✅", settings, false); Check(!rules.Values.ContainsKey("✅"));
            Check(File.ReadAllText(Path.Combine(temporary, "ReplaceStudy.dic"), Encoding.UTF8).Contains(astral));
            Console.WriteLine("Native education: emoji, 30-character boundary, legacy restore/forget and UTF-16 dictionary buckets passed.");
        } finally { Directory.Delete(temporary, true); }
    }
}
namespace FNF.Utility {
    public class EducationProcessor {
        public MultiReplacer ReplaceStudies;
        public EducationProcessor(MultiReplacer rules) { ReplaceStudies = rules; }
        public StringBuilder ConvertToUnifiedText(StringBuilder text) { return new StringBuilder(text.ToString().Normalize(NormalizationForm.FormKC)); }
    }
    public class MultiReplacer {
        public enum WordType { English, Normal }
        public Dictionary<string, string> Values = new Dictionary<string, string>();
        public int LastBucketLength;
        public void RemoveRule(int length, string source) { if (length != source.Length) throw new Exception("Incorrect dictionary bucket"); Values.Remove(source); }
        public void AddRule(int length, WordType type, string source, string reading) { if (length != source.Length) throw new Exception("Incorrect dictionary bucket"); LastBucketLength = length; Values[source] = reading; }
        public void SaveRule(string path) {
            List<string> lines = new List<string>(); foreach (KeyValuePair<string, string> row in Values) lines.Add(row.Key.Length + "\tN\t" + row.Key + "\t" + row.Value);
            File.WriteAllLines(path, lines.ToArray(), Encoding.UTF8);
        }
    }
}

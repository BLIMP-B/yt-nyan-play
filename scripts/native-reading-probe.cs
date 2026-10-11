using System;
public static class NativeReadingProbe {
    static void Check(bool condition) { if (!condition) throw new Exception("Native reading provenance regression"); }
    public static int Main() {
        // Default homoglyph rules yielding A/E must not protect those letters in
        // an unrelated Roman name. Real literal/regex education stays eligible.
        Check(!BouyomiBridge.RuleWasPresent("ERAI", "Д", false));
        Check(!BouyomiBridge.RuleWasPresent("ERAI", "Ε", false));
        Check(BouyomiBridge.RuleWasPresent("ＥＲＡＩ", "erai", false));
        Check(BouyomiBridge.RuleWasPresent("ERAI", "^erai$", true));
        Check(!BouyomiBridge.RuleWasPresent("ERAI", "^cat$", true));
        Check(!BouyomiBridge.RuleWasPresent("ERAI", "(", true));
        Console.WriteLine("Native reading provenance passed."); return 0;
    }
}

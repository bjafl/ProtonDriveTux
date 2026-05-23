import { createContext, useContext, useState } from "react";
import { T } from "./translations";
import type { Lang, Translations } from "./translations";
export type { Translations, Lang };

interface LangContextValue {
  lang: Lang;
  t: Translations;
  toggleLang: () => void;
}

const LangContext = createContext<LangContextValue>({
  lang: "no",
  t: T.no,
  toggleLang: () => {},
});

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    const stored = localStorage.getItem("lang") as Lang | null;
    if (stored === "no" || stored === "en") return stored;
    return navigator.language.startsWith("no") ? "no" : "en";
  });

  const toggleLang = () =>
    setLang((l) => {
      const next: Lang = l === "no" ? "en" : "no";
      localStorage.setItem("lang", next);
      return next;
    });

  return (
    <LangContext.Provider value={{ lang, t: T[lang], toggleLang }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}

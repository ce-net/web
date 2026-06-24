import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { createClient } from "./ce";

// One React Native UI. `expo export --platform web` compiles it through
// react-native-web into a static bundle the CE hub can host. The CE client is
// browser-only; on web (the export target) it persists to the CE database.
const ce = createClient();
const COUNT_KEY = "count";

export default function App() {
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(false);
  const onWeb = Platform.OS === "web";

  useEffect(() => {
    if (!onWeb) {
      setReady(true);
      return;
    }
    ce.db
      .get(COUNT_KEY)
      .then((v) => {
        if (typeof v === "number") setCount(v);
      })
      .finally(() => setReady(true));
  }, [onWeb]);

  useEffect(() => {
    if (!ready || !onWeb) return;
    ce.db.set(COUNT_KEY, count).catch(() => {});
  }, [count, ready, onWeb]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.brandRow}>
        <Text style={styles.brand}>React Native on CE</Text>
      </View>
      <Text style={styles.h1}>One UI, every screen</Text>
      <Text style={styles.lede}>
        A single React Native component, exported to the web with react-native-web and hosted on CE.
        {onWeb ? " The count persists to the CE database." : " (db persists on the web build.)"}
      </Text>

      <View style={styles.card}>
        <Pressable style={styles.btn} onPress={() => setCount((c) => c - 1)}>
          <Text style={styles.btnText}>{"−"}</Text>
        </Pressable>
        <Text style={styles.num}>{ready ? String(count) : "…"}</Text>
        <Pressable style={styles.btn} onPress={() => setCount((c) => c + 1)}>
          <Text style={styles.btnText}>+</Text>
        </Pressable>
      </View>

      <Text style={styles.note}>
        persisted at /db/{ce.appId}/{COUNT_KEY}
      </Text>
    </View>
  );
}

const display = Platform.select({ web: "Fraunces, serif", default: "System" });
const mono = Platform.select({ web: "JetBrains Mono, monospace", default: "Menlo" });
const body = Platform.select({ web: "Hanken Grotesk, sans-serif", default: "System" });

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#03060e",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  brandRow: { marginBottom: 18 },
  brand: { color: "#37c6ff", fontFamily: display, fontSize: 18, fontWeight: "600" },
  h1: {
    color: "#e9f1fb",
    fontFamily: display,
    fontSize: 36,
    fontWeight: "600",
    letterSpacing: -0.6,
    textAlign: "center",
  },
  lede: {
    color: "#92a8c6",
    fontFamily: body,
    fontSize: 15,
    lineHeight: 24,
    textAlign: "center",
    maxWidth: 380,
    marginTop: 10,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
    borderWidth: 1,
    borderColor: "rgba(116,176,255,0.13)",
    borderRadius: 18,
    backgroundColor: "#0a1422",
    paddingHorizontal: 26,
    paddingVertical: 22,
    marginTop: 28,
  },
  btn: {
    width: 56,
    height: 56,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(116,176,255,0.13)",
    backgroundColor: "rgba(116,176,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  btnText: { color: "#e9f1fb", fontSize: 28 },
  num: {
    color: "#e9f1fb",
    fontFamily: display,
    fontSize: 52,
    fontWeight: "600",
    minWidth: 90,
    textAlign: "center",
  },
  note: { color: "#5e768f", fontFamily: mono, fontSize: 12, marginTop: 18 },
});

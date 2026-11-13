import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api.js";

interface RuntimeFlags {
  loaded: boolean;
  devMail: boolean;
  demoLogin: boolean;
  mailDelivery: boolean;
  federatedLogin: boolean;
}

export function useRuntimeFlags(): RuntimeFlags {
  const [flags, setFlags] = useState<RuntimeFlags>({ loaded: false, devMail: false, demoLogin: false, mailDelivery: false, federatedLogin: false });
  useEffect(() => {
    let cancelled = false;
    api<Partial<RuntimeFlags>>("/api/health")
      .then((result) => {
        if (!cancelled) setFlags({ loaded: true, devMail: result.devMail === true, demoLogin: result.demoLogin === true, mailDelivery: result.mailDelivery === true, federatedLogin: result.federatedLogin === true });
      })
      .catch(() => { /* Optional controls stay hidden if server capabilities cannot be read. */ });
    return () => { cancelled = true; };
  }, []);
  return flags;
}

export function DevMailLink({ separator = false }: { separator?: boolean }) {
  const flags = useRuntimeFlags();
  return flags.devMail ? <>{separator ? " · " : ""}<Link to="/dev/mail">Development mail</Link></> : null;
}

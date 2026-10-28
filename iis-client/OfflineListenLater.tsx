import { useState } from "react";
import { ListenLater, ListenLaterProvider } from "../app/ListenLater";
import { ListeningQueueClient } from "../app/listening-queue";
import { clearSharedListening } from "../app/shared-listening";

function savedAccounts() {
  const accounts: string[] = [], prefix = "signal.listening-queue.v1.";
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index); if (!key?.startsWith(prefix)) continue;
      const email = decodeURIComponent(key.slice(prefix.length));
      const client = new ListeningQueueClient(email, localStorage, () => {}, fetch, false);
      if (client.saved().items.length) accounts.push(email); client.dispose();
    }
  } catch { /* No offline copy is available. */ }
  return accounts;
}
/** Local queue only. It never treats cached identity as an authenticated Signal session. */
export default function OfflineListenLater() {
  const [accounts, setAccounts] = useState(savedAccounts), [selected, setSelected] = useState(() => accounts[0] ?? "");
  return <main className="auth-shell offline-listen-later" style={{ display: "block", maxWidth: 1000, margin: "auto", padding: 20 }}>
    <h1>Offline Listen later</h1><p>Signal cannot connect. You can play the story text saved on this device with a device voice. Changes stay here until you reconnect and sign in to the same account.</p>
    <button type="button" onClick={() => location.reload()}>Reconnect to Signal</button>
    {accounts.length > 1 && <label>Saved account <select value={selected} onChange={event => setSelected(event.target.value)}>{accounts.map(email => <option key={email}>{email}</option>)}</select></label>}
    {selected && <p>Saved account: {selected}</p>}
    {selected ? <>
      <ListenLaterProvider key={selected} email={selected} syncEnabled={false}><ListenLater /></ListenLaterProvider>
      <button type="button" onClick={() => { clearSharedListening(selected); const remaining = accounts.filter(email => email !== selected); setAccounts(remaining); setSelected(remaining[0] ?? ""); }}>Remove offline copy from this device</button>
    </> : <p>No stories are saved on this device. Reconnect and add stories to Listen later first.</p>}
  </main>;
}

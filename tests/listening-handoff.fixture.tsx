import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import WatchListeningHandoff from '../app/WatchListeningHandoff';
import '../app/globals.css';
function Fixture(){const[open,setOpen]=useState(true);return <main>{open?<WatchListeningHandoff id={'a'.repeat(64)} onClose={()=>setOpen(false)}/>:<p>Transfer closed</p>}</main>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);

import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SharedListeningProvider,SharedListeningResume} from '../app/SharedListening';
import {clearSharedListening} from '../app/shared-listening';
import ArticleAudioPlayer from '../app/ArticleAudioPlayer';
import '../app/globals.css';
const parts=['Heading.','Exact saved section.','Final saved section.'];
function Fixture(){const[start,setStart]=useState(false),[signed,setSigned]=useState(true);return signed?<SharedListeningProvider email="owner@example.com">
  <h1>Shared listening</h1><SharedListeningResume/><button onClick={()=>setStart(true)}>Start a story</button>
  <button onClick={()=>{clearSharedListening('owner@example.com');setSigned(false)}}>Sign out</button>
  {start&&<ArticleAudioPlayer title="Story" source="Publisher" storyUrl="https://example.com/story" paragraphs={parts}
    narrationSections={parts.map((text,index)=>({text,paragraphIndex:index,start:0,end:text.length}))} autoPrepare/>}
</SharedListeningProvider>:<p>Signed out</p>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture/></React.StrictMode>);

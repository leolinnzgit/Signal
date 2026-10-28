import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ListenLaterProvider,ListenLater,ListenLaterButton} from '../app/ListenLater';
import {clearSharedListening} from '../app/shared-listening';
import '../app/globals.css';
function Fixture(){const[signed,setSigned]=useState(true);return signed?<ListenLaterProvider email="owner@example.com"><main style={{maxWidth:950,margin:'auto',padding:16}}>
 <h1>Your stories</h1><ListenLater/>
 <ListenLaterButton url="https://example.com/alpha" title="Alpha story" source="Publisher" imageUrl="https://images.example.com/a.jpg"/>
 <ListenLaterButton url="https://example.com/beta" title="Beta story" source="Publisher" paragraphs={['Beta first section.','Beta final section.']}/>
 <button onClick={()=>{clearSharedListening('owner@example.com');setSigned(false)}}>Sign out</button>
 </main></ListenLaterProvider>:<p>Signed out</p>}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);

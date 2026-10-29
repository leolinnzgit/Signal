import React from 'react';
import {createRoot} from 'react-dom/client';
import {ListenLater,ListenLaterProvider} from '../app/ListenLater';
import '../app/globals.css';
createRoot(document.getElementById('root')!).render(<ListenLaterProvider email="owner@example.com"><main><ListenLater/><button onClick={()=>window.dispatchEvent(new CustomEvent('signal.shared-listening-signout',{detail:'owner@example.com'}))}>Sign out test</button></main></ListenLaterProvider>);

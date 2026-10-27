import React from 'react';
import {createRoot} from 'react-dom/client';
import ArticleAudioPlayer from '../app/ArticleAudioPlayer';
import '../app/globals.css';
const parts=['Heading.', 'First exact section.', 'Later exact section.'];
createRoot(document.getElementById('root')!).render(<React.StrictMode><main>
  <h1>Continue on watch test</h1>
  <ArticleAudioPlayer title="Story" source="Publisher" storyUrl="https://example.com/story" storyImageUrl={new URLSearchParams(location.search).get('image') || 'https://images.example.com/story.jpg'} paragraphs={parts}
    defaultMode={new URLSearchParams(location.search).get('mode') === 'browser' ? 'browser' : 'recorded'} narrationSections={parts.map((text,index)=>({text,paragraphIndex:index,start:0,end:text.length}))} autoPrepare />
</main></React.StrictMode>);

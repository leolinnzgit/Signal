"""Install-time offline verification, catalog and sample generation."""
import argparse
import json
import struct
import subprocess
import sys
import time
import wave
from pathlib import Path
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument("--root",type=Path,required=True)
parser.add_argument("--worker",type=Path,default=Path(__file__).with_name("kokoro_worker.py"))
parser.add_argument("--english",default="bf_emma")
parser.add_argument("--chinese",default="zf_xiaobei")
args=parser.parse_args()
with np.load(args.root/"voices-v1.0.bin",allow_pickle=False) as data:
    names=[name for name in data.files if name[0] in "abz"]
    if args.english not in names or args.chinese not in names or args.english[0] not in "ab" or args.chinese[0] != "z":
        raise ValueError("Default voices are not installed in the requested languages")
    catalog=[{"id":"kokoro/"+name,"name":name.split("_",1)[1].title()+" (Kokoro)","language":{"a":"en-US","b":"en-GB","z":"zh-CN"}[name[0]],"gender":"Female" if name[1]=="f" else "Male"} for name in names]
clips=[{"Voice":args.english,"Text":"Signal speech is ready."},{"Voice":args.chinese,"Text":"語音已準備好。"}]
start=time.perf_counter()
result=subprocess.run([sys.executable,"-I",str(args.worker),"--root",str(args.root),"--threads","4"],input=(json.dumps(clips)+"\n").encode("utf-8"),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180,check=True)
raw=result.stdout
header_size=struct.unpack("<I",raw[:4])[0]
lengths=json.loads(raw[4:4+header_size])
if len(lengths)!=2 or len(raw)!=4+header_size+sum(lengths): raise ValueError("Incomplete worker recording")
position=4+header_size
for language,length in zip(["en","zh"],lengths):
    pcm=raw[position:position+length];position+=length
    if length<3200 or length%2 or not np.any(np.frombuffer(pcm,dtype="<i2")): raise ValueError("Silent narration")
    with wave.open(str(args.root/("sample-"+language+".wav")),"wb") as audio:
        audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(pcm)
(args.root/"voices.json").write_text(json.dumps(catalog),encoding="utf-8")
print(json.dumps({"voices":len(catalog),"preparedInSeconds":round(time.perf_counter()-start,2),"audioSeconds":[round(length/32000,2) for length in lengths]}))

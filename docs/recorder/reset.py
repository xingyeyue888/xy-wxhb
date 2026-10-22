import urllib.request, urllib.parse, json, time, sys
B="http://127.0.0.1:8188"
name="演示-文生图.json"
url=B+"/api/userdata/"+urllib.parse.quote("workflows/"+name,safe="")
wf=json.load(urllib.request.urlopen(url+"?_="+str(time.time())))
NEW="a brass pocket watch on a dark walnut desk, single window light, shallow depth of field, product photo"
for n in wf["nodes"]:
    if str(n["id"])=="6":
        if isinstance(n.get("widgets_values"),list): n["widgets_values"][2]=8
        if n.get("widgets_values_named"): n["widgets_values_named"]["steps"]=8
    if str(n["id"])=="43":
        if isinstance(n.get("widgets_values"),list) and n["widgets_values"]: n["widgets_values"][0]=NEW
        if isinstance(n.get("widgets_values_named"),dict) and "prompt" in n["widgets_values_named"]: n["widgets_values_named"]["prompt"]=NEW
r=urllib.request.Request(url,data=json.dumps(wf).encode(),method="POST"); r.add_header("Content-Type","application/json")
print("reset:", urllib.request.urlopen(r).status)

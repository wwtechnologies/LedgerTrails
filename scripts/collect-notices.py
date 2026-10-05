"""Collect dependency license files and exact source coordinates for release downloads."""
import json, os, pathlib, shutil, subprocess, platform
root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'release-notices' / platform.system()
out.mkdir(parents=True, exist_ok=True)
shutil.copy2(root / 'LICENSE', out / 'LedgerTrails-LICENSE.txt')
records = []
def copy_notices(folder, dest):
    dest.mkdir(parents=True, exist_ok=True)
    for p in folder.iterdir():
        if p.is_file() and p.name.lower().startswith(('license', 'licence', 'copying', 'notice', 'copyright')):
            shutil.copy2(p, dest / p.name)
metadata = json.loads(subprocess.check_output(['cargo','metadata','--locked','--format-version','1','--manifest-path',str(root/'src-tauri/Cargo.toml')]))
for package in metadata['packages']:
    if not package['source']: continue
    name,version = package['name'],package['version']
    dest = out/'rust'/f'{name}-{version}'
    folder = pathlib.Path(package['manifest_path']).parent
    copy_notices(folder, dest)
    if package.get('license_file'):
        p=folder/package['license_file']
        if p.is_file(): shutil.copy2(p,dest/p.name)
    records.append({'ecosystem':'rust','name':name,'version':version,'license':package['license'],'repository':package['repository'],'source':f'https://crates.io/api/v1/crates/{name}/{version}/download'})
lock=json.loads((root/'package-lock.json').read_text(encoding="utf-8"))
for rel,pkg in lock['packages'].items():
    if not rel: continue
    folder=root/rel
    if not (folder/'package.json').is_file(): continue
    data=json.loads((folder/'package.json').read_text(encoding="utf-8"))
    name,version=data['name'],data['version']
    dest=out/'npm'/(name.replace('/','_')+'-'+version)
    copy_notices(folder,dest)
    records.append({'ecosystem':'npm','name':name,'version':version,'license':data.get('license'),'repository':data.get('repository'),'source':pkg.get('resolved')})
if platform.system()=='Linux':
    # The AppImage bundles system libraries. Include installed distribution notices
    # and package coordinates, in addition to application dependency notices.
    if shutil.which('dpkg-query'):
        packages=subprocess.check_output(['dpkg-query','-W','-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n'],text=True)
        (out/'SYSTEM-PACKAGES.txt').write_text(packages)
        for copyright in pathlib.Path('/usr/share/doc').glob('*/copyright'):
            if copyright.is_file():
                dest=out/'system'/copyright.parent.name
                dest.mkdir(parents=True,exist_ok=True)
                shutil.copy2(copyright,dest/'copyright')
        (out/'SYSTEM-SOURCES.txt').write_text('Built on Ubuntu 24.04. Exact installed binary/source package versions are in SYSTEM-PACKAGES.txt. Distribution source archives: https://archive.ubuntu.com/ubuntu/pool/ and https://security.ubuntu.com/ubuntu/pool/. Each package copyright file contains its upstream source and license. Use apt-get source PACKAGE=SOURCE_VERSION with Ubuntu source repositories enabled. The AppImage permits replacing/relinking its shared libraries by extracting its contents with --appimage-extract.\n')
    else:
        (out/'SYSTEM-SOURCES.txt').write_text('System package source coordinates were not collected because dpkg-query was unavailable on this Linux build host. Application dependency source coordinates are in DEPENDENCIES.json. The AppImage permits replacing/relinking its shared libraries by extracting its contents with --appimage-extract.\n')
(out/'DEPENDENCIES.json').write_text(json.dumps(records,indent=2)+'\n')
(out/'SOURCES.txt').write_text('LedgerTrails source: https://github.com/wwtechnologies/LedgerTrails/tree/v0.1.2\nExact Rust and npm dependency source downloads are in DEPENDENCIES.json. Bundled hledger 1.52.1 source and license accompany this release separately.\n')
print(f'Collected notices for {len(records)} dependencies into {out}')

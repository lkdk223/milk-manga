"""Build a development-signed Android APK using the JDK and Android SDK only."""
import argparse
import os
from pathlib import Path
import subprocess
import zipfile
import shutil

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--sdk', type=Path, required=True)
parser.add_argument('--jdk', type=Path, required=True)
args = parser.parse_args()
sdk, jdk = args.sdk.resolve(), args.jdk.resolve()
tools = sdk / 'build-tools/35.0.1'
android = sdk / 'platforms/android-35/android.jar'
build = root / 'build'
if build.resolve().parent != root:
    raise SystemExit('Build directory must be inside this project')
for name in ['gen', 'classes', 'dex']:
    directory = build / name
    if directory.resolve().parent != build.resolve():
        raise SystemExit('Unexpected build output path')
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True)

def run(*command):
    subprocess.run([str(x) for x in command], cwd=root, check=True)

run(tools/'aapt.exe', 'package', '-f', '-m', '-J', build/'gen', '-M', root/'AndroidManifest.xml',
    '-S', root/'res', '-A', root/'assets', '-I', android, '-F', build/'resources.apk')
sources = list((root/'src').rglob('*.java')) + list((build/'gen').rglob('*.java'))
run(jdk/'bin/javac.exe', '-encoding', 'UTF-8', '--release', '8', '-classpath', android, '-d', build/'classes', *sources)
run(jdk/'bin/jar.exe', 'cf', build/'classes.jar', '-C', build/'classes', '.')
run(jdk/'bin/java.exe', '-cp', tools/'lib/d8.jar', 'com.android.tools.r8.D8', '--lib', android,
    '--min-api', '26', '--output', build/'dex', build/'classes.jar')
(build/'unsigned.apk').write_bytes((build/'resources.apk').read_bytes())
with zipfile.ZipFile(build/'unsigned.apk', 'a', compression=zipfile.ZIP_DEFLATED) as apk:
    apk.write(build/'dex/classes.dex', 'classes.dex')
run(tools/'zipalign.exe', '-f', '-p', '4', build/'unsigned.apk', build/'aligned.apk')
key = root / '.local-signing/development.jks'
key.parent.mkdir(exist_ok=True)
if not key.exists():
    run(jdk/'bin/keytool.exe', '-genkeypair', '-keystore', key, '-storepass', 'android',
        '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048',
        '-validity', '10000', '-dname', 'CN=Milk Manga Development')
output = root/'milk-manga-0.3.0.apk'
run(jdk/'bin/java.exe', '-jar', tools/'lib/apksigner.jar', 'sign', '--ks', key,
    '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', output, build/'aligned.apk')
run(jdk/'bin/java.exe', '-jar', tools/'lib/apksigner.jar', 'verify', '--verbose', output)
run(tools/'aapt.exe', 'dump', 'badging', output)
print(f'APK ready: {output} ({output.stat().st_size:,} bytes)')

package com.milkmanga.reader;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowInsets;
import android.webkit.*;
import android.widget.FrameLayout;
import android.view.ViewGroup;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.*;
import java.net.*;
import java.nio.charset.Charset;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.GZIPInputStream;

public final class MainActivity extends Activity {
    private WebView web;
    private LocalBooks localBooks;
    private ImageCache images;
    private final ExecutorService prefetch = Executors.newSingleThreadExecutor();
    private volatile int prefetchToken;
    private final Handler maintenanceHandler=new Handler(Looper.getMainLooper());
    private final Runnable maintenanceTick=new Runnable() {
        @Override public void run() {
            if(destroyed)return;
            network.execute(()->CacheMaintenance.check(MainActivity.this));
            maintenanceHandler.postDelayed(this,60000);
        }
    };
    private volatile boolean destroyed;
    private final ExecutorService network = Executors.newFixedThreadPool(4);
    private static final String ORIGIN = "app.milkmanga.local";
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    static boolean allowed(String address) {
        try {
            URI uri = new URI(address);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && uri.getUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && ("www.mangabz.com".equals(host) || "mangabz.com".equals(host)
                    || "cover.mangabz.com".equals(host) || "image.mangabz.com".equals(host));
        } catch (Exception e) { return false; }
    }

    private static HttpURLConnection open(String url, JSONObject headers, boolean imageRequest) throws Exception {
        for (int redirect = 0; redirect < 5; redirect++) {
            if (!allowed(url)) throw new IOException("不支持的资源地址");
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(imageRequest);
            if (!imageRequest) c.setRequestProperty("Cache-Control", "no-cache");
            c.setConnectTimeout(15000); c.setReadTimeout(25000);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Referer", "https://www.mangabz.com/");
            c.setRequestProperty("Cookie", "mangabz_lang=2");
            for (String key : Arrays.asList("User-Agent", "Referer", "Cookie", "Accept", "Accept-Language", "X-Requested-With")) {
                if (headers.has(key)) c.setRequestProperty(key, headers.getString(key));
            }
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = c.getHeaderField("Location");
                String next = location == null ? null : new URL(new URL(url), location).toString();
                c.disconnect();
                if (next == null) throw new IOException("资源重定向无效");
                url = next;
            } else return c;
        }
        throw new IOException("资源重定向次数过多");
    }

    private static byte[] read(InputStream stream, int limit) throws IOException {
        try (InputStream in = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] block = new byte[16384]; int n;
            while ((n = in.read(block)) != -1) {
                if (out.size() + n > limit) throw new IOException("资源过大，请换一个章节");
                out.write(block, 0, n);
            }
            return out.toByteArray();
        }
    }
    static String decode(byte[] bytes, String type) {
        if (type != null && type.toLowerCase(Locale.ROOT).contains("charset=gb")) return new String(bytes, Charset.forName("GB18030"));
        try { return Charset.forName("UTF-8").newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); }
        catch (CharacterCodingException e) { return new String(bytes, Charset.forName("GB18030")); }
    }

    private ImageCache.Image image(String url,boolean bypass,int version) throws Exception {
        if(!bypass) {ImageCache.Image found=images.get(url);if(found!=null)return found;}
        for(int attempt=0;attempt<2;attempt++) {
            HttpURLConnection c=null;
            try {
                c=open(url,new JSONObject(),false);
                if(c.getResponseCode()!=200)throw new IOException();
                String mime=c.getContentType();
                if(mime==null||!mime.startsWith("image/"))throw new IOException();
                ImageCache.Image result=new ImageCache.Image(mime.split(";")[0],read(c.getInputStream(),ImageCache.MAX_IMAGE));
                try {images.put(url,result,version);}catch(IOException ignored) { /* Foreground display still works without disk space. */ }
                return result;
            } catch(IOException e) {
                if(attempt==1)throw e;
                Thread.sleep(400);
            } finally {if(c!=null)c.disconnect();}
        }
        throw new IOException();
    }

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        localBooks=new LocalBooks(this);
        images=CacheMaintenance.images(this);
        CacheMaintenance.check(this);
        web = new WebView(this);
        web.setBackgroundColor(0xfff3f6f8);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setBuiltInZoomControls(true);
        web.getSettings().setDisplayZoomControls(false);
        web.addJavascriptInterface(new Bridge(), "Android");
        CacheMaintenance.onCleared=()->{
            prefetchToken++;
            web.post(()->{if(!destroyed){web.clearCache(true);web.evaluateJavascript("window.__onlineCacheCleared && window.__onlineCacheCleared()",null);}});
        };
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !ORIGIN.equals(r.getUrl().getHost());
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                String url = r.getUrl().toString();
                try {
                    if (ORIGIN.equals(r.getUrl().getHost())) {
                        String file = r.getUrl().getPath();
                        if(file!=null&&file.startsWith("/local/"))return localBooks.image(r.getUrl());
                        if ("/".equals(file)) file = "/index.html";
                        if (!Arrays.asList("/index.html", "/app.css", "/shelf.css", "/app.js", "/source.js", "/app-icon.png").contains(file)) throw new IOException();
                        String mime = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "application/javascript" : file.endsWith(".png") ? "image/png" : "text/html";
                        return new WebResourceResponse(mime, "UTF-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-store"), getAssets().open(file.substring(1)));
                    }
                    if (!allowed(url) || !r.getUrl().getHost().startsWith("image.") && !r.getUrl().getHost().startsWith("cover.")) throw new IOException();
                    ImageCache.Image result=image(url,r.getUrl().getQueryParameterNames().contains("_retry"),images.generation());
                    return new WebResourceResponse(result.mime,null,200,"OK",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(result.bytes));
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "UTF-8", 503, "Unavailable", Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
                }
            }
        });
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(0xfff3f6f8);
        frame.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(frame);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            frame.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, insets.getInsets(WindowInsets.Type.ime()).bottom));
                return WindowInsets.CONSUMED;
            });
        } else frame.setFitsSystemWindows(true);
        web.loadUrl("https://" + ORIGIN + "/");
    }

    public final class Bridge {
        @JavascriptInterface public int cachedPages(String rawUrls) {
            if(rawUrls.length()>2000000)return 0;
            try {
                JSONArray urls=new JSONArray(rawUrls);if(urls.length()>5000)return 0;
                int count=0;for(int i=0;i<urls.length();i++)if(images.contains(urls.getString(i)))count++;
                return count;
            }catch(Exception e){return 0;}
        }
        @JavascriptInterface public void cancelPrefetch(int token) {prefetchToken=token;}
        @JavascriptInterface public void prefetchImages(String id,int token,String rawUrls) {
            if(id.length()>32||rawUrls.length()>2000000)return;
            final int version=images.generation();
            prefetch.execute(()->{
                int done=0,total=0;boolean cancelled=false;
                try {
                    JSONArray urls=new JSONArray(rawUrls);total=urls.length();
                    if(total<1||total>5000)throw new IOException();
                    for(int i=0;i<total;i++) {
                        if(destroyed||token!=prefetchToken||version!=images.generation()){cancelled=true;break;}
                        String url=urls.getString(i);
                        if(url.length()>6000)continue;
                        try {
                            ImageCache.key(url);
                            image(url,false,version);
                            if(images.contains(url))done++;
                        }catch(Exception ignored) {if(Thread.currentThread().isInterrupted())break;}
                        if(i%5==4 || i==total-1)postJs("window.__prefetchProgress("+JSONObject.quote(id)+","+done+","+total+")");
                    }
                } catch(Exception ignored) {}
                cancelled=cancelled||destroyed||token!=prefetchToken||version!=images.generation();
                postJs("window.__prefetchDone("+JSONObject.quote(id)+",{done:"+done+",total:"+total+",cancelled:"+cancelled+"})");
            });
        }
        @JavascriptInterface public void importLocal() {
            runOnUiThread(() -> {
                Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);
                intent.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"image/*","application/pdf","application/zip","application/x-zip-compressed","application/x-cbz","application/vnd.comicbook+zip","application/octet-stream"});
                try {startActivityForResult(intent,3107);}catch(Exception e){postJs("window.__localImportFailed('无法打开系统文件选择器')");}
            });
        }
        @JavascriptInterface public void request(final String id, final String url, final String rawHeaders) {
            if (id.length() > 32 || url.length() > 6000 || rawHeaders.length() > 6000) return;
            network.execute(() -> {
                JSONObject result = new JSONObject();
                try {
                    HttpURLConnection c = open(url, new JSONObject(rawHeaders), false);
                    try {
                        int code = c.getResponseCode();
                        InputStream input = code < 400 ? c.getInputStream() : c.getErrorStream();
                        if (input == null) throw new IOException("HTTP " + code);
                        if ("gzip".equals(c.getContentEncoding())) input = new GZIPInputStream(input);
                        byte[] bytes = read(input, 8 * 1024 * 1024);
                        result.put("status", code); result.put("body", decode(bytes,c.getContentType()));
                    } finally { c.disconnect(); }
                } catch (Exception e) {
                    try { result.put("status", 0); result.put("body", ""); result.put("error", "连接失败，请检查网络后重试"); } catch (Exception ignored) {}
                }
                final String response = result.toString();
                postJs("window.__networkDone(" + JSONObject.quote(id) + "," + response + ")");
            });
        }
    }
    private void postJs(String script){if(!destroyed)web.post(()->{if(!destroyed)web.evaluateJavascript(script,null);});}
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);if(request!=3107)return;
        if(result!=RESULT_OK||data==null){postJs("window.__localImportCancelled()");return;}
        LinkedHashSet<Uri> selected=new LinkedHashSet<>();
        if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++)selected.add(data.getClipData().getItemAt(i).getUri());
        else if(data.getData()!=null)selected.add(data.getData());
        postJs("window.__localImportStatus('正在导入到本机，请稍候…')");
        network.execute(()->{
            try {JSONObject book=localBooks.importFiles(new ArrayList<>(selected));postJs("window.__localImported("+book.toString()+")");}
            catch(Exception e){String message=e.getMessage();if(message==null||!message.matches("^(文件|本地|PDF|漫画|请选择|图片|压缩包).*$"))message="导入失败，请确认文件完整、未加密且格式受支持";postJs("window.__localImportFailed("+JSONObject.quote(message)+")");}
        });
    }
    @Override public void onBackPressed() {
        web.evaluateJavascript("window.goBack ? window.goBack() : false", value -> { if (!"true".equals(value)) finish(); });
    }
    @Override protected void onResume() {super.onResume();CacheMaintenance.schedule(this);maintenanceHandler.removeCallbacks(maintenanceTick);maintenanceTick.run();}
    @Override protected void onPause() {maintenanceHandler.removeCallbacks(maintenanceTick);web.evaluateJavascript("window.saveProgress && window.saveProgress()", null); super.onPause(); }
    @Override protected void onDestroy() {destroyed=true;CacheMaintenance.onCleared=null;maintenanceHandler.removeCallbacks(maintenanceTick);prefetch.shutdownNow();web.removeJavascriptInterface("Android"); web.destroy(); network.shutdownNow(); super.onDestroy(); }
}

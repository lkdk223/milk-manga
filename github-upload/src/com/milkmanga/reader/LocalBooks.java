package com.milkmanga.reader;

import android.content.Context;
import android.net.Uri;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.os.ParcelFileDescriptor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.webkit.WebResourceResponse;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.charset.Charset;
import java.util.*;
import java.util.concurrent.Semaphore;
import java.util.zip.*;

final class LocalBooks {
    // ponytail: import at most 512 MiB / 5000 pages; larger libraries need streaming indexes.
    private static final long MAX_BOOK = 512L * 1024 * 1024;
    private static final int MAX_IMAGE = 24 * 1024 * 1024;
    private static final Semaphore PDF_SLOTS = new Semaphore(2);
    private final Context context;
    private final File base;
    LocalBooks(Context context) { this.context=context; base=new File(context.getFilesDir(),"local-books"); }

    static boolean imageName(String name) { return name.toLowerCase(Locale.ROOT).matches(".*\\.(jpg|jpeg|png|webp|gif|bmp|avif)$"); }
    static int naturalCompare(String a, String b) {
        int i=0,j=0;
        while(i<a.length()&&j<b.length()) {
            char x=Character.toLowerCase(a.charAt(i)),y=Character.toLowerCase(b.charAt(j));
            if(x>='0'&&x<='9'&&y>='0'&&y<='9') {
                int endA=i,endB=j;while(endA<a.length()&&Character.isDigit(a.charAt(endA)))endA++;while(endB<b.length()&&Character.isDigit(b.charAt(endB)))endB++;
                String left=a.substring(i,endA).replaceFirst("^0+(?!$)",""),right=b.substring(j,endB).replaceFirst("^0+(?!$)","");
                if(left.length()!=right.length())return Integer.compare(left.length(),right.length());
                int n=left.compareTo(right);if(n!=0)return n;i=endA;j=endB;
            } else { if(x!=y)return Character.compare(x,y);i++;j++; }
        }
        int length=Integer.compare(a.length(),b.length());return length!=0?length:a.compareTo(b);
    }
    static List<String> zipImages(ZipFile zip) throws IOException {
        List<String> names=new ArrayList<>();Enumeration<? extends ZipEntry> entries=zip.entries();int count=0;
        while(entries.hasMoreElements()) {
            if(++count>30000)throw new IOException("压缩包条目过多");
            ZipEntry e=entries.nextElement();String name=e.getName(),normalized=name.replace('\\','/');
            if(name.length()>1024)throw new IOException("压缩包文件名过长");
            if(e.isDirectory()||!imageName(name)||normalized.startsWith("/")||Arrays.asList(normalized.split("/")).contains("..")||normalized.startsWith("__MACOSX/"))continue;
            if(e.getSize()>MAX_IMAGE)throw new IOException("图片超过 24 MiB，请缩小后导入");
            names.add(name);if(names.size()>5000)throw new IOException("漫画超过 5000 页");
        }
        names.sort(LocalBooks::naturalCompare);return names;
    }
    static ZipFile openZip(File file) throws IOException {
        try { return new ZipFile(file); }
        catch(IllegalArgumentException|ZipException e) { return new ZipFile(file,Charset.forName("GB18030")); }
    }
    private String name(Uri uri) {
        try(Cursor c=context.getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)) {
            if(c!=null&&c.moveToFirst())return c.getString(0).replaceAll("[\\r\\n\\t]"," ");
        } catch(Exception ignored) {}
        return "本地漫画";
    }
    private long copy(Uri uri,File target,long limit) throws IOException {
        if(!"content".equals(uri.getScheme()))throw new IOException("请选择系统文件选择器中的文件");
        try(InputStream in=context.getContentResolver().openInputStream(uri);OutputStream out=new FileOutputStream(target)) {
            if(in==null)throw new IOException("文件无法读取");
            byte[] block=new byte[65536];long total=0;int n;
            while((n=in.read(block))!=-1) {
                total+=n;if(total>limit)throw new IOException("文件过大：单本上限 512 MiB，单张图片上限 24 MiB");
                if(Thread.currentThread().isInterrupted())throw new IOException("文件导入已中断");
                out.write(block,0,n);
            }
            return total;
        }
    }
    JSONObject importFiles(List<Uri> uris) throws Exception {
        if(uris.isEmpty()||uris.size()>5000)throw new IOException("请选择 1 至 5000 张图片，或一个漫画包／PDF");
        if(!base.exists()&&!base.mkdirs())throw new IOException("本地存储无法创建目录");
        String id=UUID.randomUUID().toString().replace("-","");File folder=new File(base,id);
        if(!folder.mkdir())throw new IOException("本地存储无法创建目录");
        try {
            String firstName=name(uris.get(0)),lower=firstName.toLowerCase(Locale.ROOT),format;
            JSONObject meta=new JSONObject();JSONArray pages=new JSONArray();
            if(uris.size()==1&&(lower.endsWith(".pdf")||"application/pdf".equals(context.getContentResolver().getType(uris.get(0))))) {
                format="pdf";File pdf=new File(folder,"book.pdf");copy(uris.get(0),pdf,MAX_BOOK);
                try(ParcelFileDescriptor fd=ParcelFileDescriptor.open(pdf,ParcelFileDescriptor.MODE_READ_ONLY);PdfRenderer renderer=new PdfRenderer(fd)) {
                    int count=renderer.getPageCount();if(count<1||count>5000)throw new IOException("PDF 页数无效或超过 5000 页");meta.put("pageCount",count);
                }
            } else if(uris.size()==1&&(lower.endsWith(".zip")||lower.endsWith(".cbz"))) {
                format="zip";File file=new File(folder,"book.zip");copy(uris.get(0),file,MAX_BOOK);
                try(ZipFile zip=openZip(file)) {for(String entry:zipImages(zip))pages.put(entry);}
                if(pages.length()==0)throw new IOException("压缩包中没有支持的漫画图片");
                meta.put("pageCount",pages.length());
            } else {
                format="images";List<Uri> ordered=new ArrayList<>(uris);Map<Uri,String> names=new HashMap<>();for(Uri uri:ordered)names.put(uri,name(uri));
                ordered.sort((a,b)->naturalCompare(names.get(a),names.get(b)));long total=0;int i=0;
                for(Uri uri:ordered) {
                    String original=names.get(uri);if(!imageName(original))throw new IOException("图片可以多选；漫画包和 PDF 请一次导入一个");
                    String filename=String.format(Locale.ROOT,"%05d",i++)+original.substring(original.lastIndexOf('.')).toLowerCase(Locale.ROOT);
                    total+=copy(uri,new File(folder,filename),Math.min(MAX_IMAGE,MAX_BOOK-total));pages.put(filename);
                }
                firstName=names.get(ordered.get(0));meta.put("pageCount",pages.length());
            }
            meta.put("format",format);meta.put("entries",pages);meta.put("title",firstName.replaceFirst("(?i)\\.(pdf|zip|cbz|jpg|jpeg|png|webp|gif|bmp|avif)$","")+(uris.size()>1?" · 图片合集":""));
            try(Writer writer=new OutputStreamWriter(new FileOutputStream(new File(folder,"manifest.json")),StandardCharsets.UTF_8)){writer.write(meta.toString());}
            return new JSONObject().put("id","local-"+id).put("title",meta.getString("title")).put("local",true).put("format",format).put("pageCount",meta.getInt("pageCount")).put("cover","https://app.milkmanga.local/local/"+id+"/0");
        } catch(Exception e) {
            if(folder.getCanonicalFile().getParentFile().equals(base.getCanonicalFile())){File[] files=folder.listFiles();if(files!=null)for(File file:files)file.delete();folder.delete();}
            throw e;
        }
    }
    private byte[] bounded(InputStream input) throws IOException {
        try(InputStream in=input;ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] block=new byte[16384];int n;while((n=in.read(block))!=-1){if(out.size()+n>MAX_IMAGE)throw new IOException("图片过大");out.write(block,0,n);}return out.toByteArray();
        }
    }
    WebResourceResponse image(Uri uri) throws Exception {
        List<String> parts=uri.getPathSegments();
        if(parts.size()!=3||!parts.get(0).equals("local")||!parts.get(1).matches("[a-f0-9]{32}")||!parts.get(2).matches("[0-9]{1,4}"))throw new IOException("本地地址无效");
        File folder=new File(base,parts.get(1));int index=Integer.parseInt(parts.get(2));
        String json=new String(bounded(new FileInputStream(new File(folder,"manifest.json"))),StandardCharsets.UTF_8);JSONObject meta=new JSONObject(json);
        if(index<0||index>=meta.getInt("pageCount"))throw new IOException("本地页码无效");
        String format=meta.getString("format"),name="";byte[] bytes;
        if(format.equals("pdf")) {
            PDF_SLOTS.acquire();
            try(ParcelFileDescriptor fd=ParcelFileDescriptor.open(new File(folder,"book.pdf"),ParcelFileDescriptor.MODE_READ_ONLY);PdfRenderer renderer=new PdfRenderer(fd);PdfRenderer.Page page=renderer.openPage(index)) {
                float scale=Math.min(2.5f,Math.min(1600f/page.getWidth(),2200f/page.getHeight()));
                Bitmap bitmap=Bitmap.createBitmap(Math.max(1,Math.round(page.getWidth()*scale)),Math.max(1,Math.round(page.getHeight()*scale)),Bitmap.Config.ARGB_8888);
                try(ByteArrayOutputStream out=new ByteArrayOutputStream()) {bitmap.eraseColor(Color.WHITE);page.render(bitmap,null,null,PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);bitmap.compress(Bitmap.CompressFormat.JPEG,90,out);bytes=out.toByteArray();}
                finally{bitmap.recycle();}
            } finally{PDF_SLOTS.release();}
        } else {
            name=meta.getJSONArray("entries").getString(index);
            if(format.equals("zip")){try(ZipFile zip=openZip(new File(folder,"book.zip"))){ZipEntry entry=zip.getEntry(name);if(entry==null)throw new IOException("本地图片不存在");bytes=bounded(zip.getInputStream(entry));}}
            else {if(!name.matches("[0-9]{5}\\.(jpg|jpeg|png|webp|gif|bmp|avif)"))throw new IOException("本地文件名无效");bytes=bounded(new FileInputStream(new File(folder,name)));}
        }
        String ext=name.contains(".")?name.substring(name.lastIndexOf('.')+1).toLowerCase(Locale.ROOT):"jpeg";
        String mime="image/"+(ext.equals("jpg")?"jpeg":ext);
        return new WebResourceResponse(mime,null,200,"OK",Collections.singletonMap("Cache-Control","private, max-age=31536000"),new ByteArrayInputStream(bytes));
    }
}

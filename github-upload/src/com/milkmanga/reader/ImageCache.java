package com.milkmanga.reader;

import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Only disposable online images live here; never receives a local-book path. */
final class ImageCache {
    private final File directory;
    private final long limit;
    private long size;
    private int generation;
    static final int MAX_IMAGE = 24 * 1024 * 1024;
    static final class Image {
        final String mime; final byte[] bytes;
        Image(String mime, byte[] bytes) { this.mime=mime; this.bytes=bytes; }
    }
    ImageCache(File directory, long limit) {
        this.directory=directory; this.limit=limit;
        directory.mkdirs();
        File[] files=directory.listFiles();
        if(files!=null)for(File f:files)size+=f.length();
    }
    static String key(String url) throws Exception {
        URI uri=new URI(url);
        if(!"https".equals(uri.getScheme()) || uri.getUserInfo()!=null ||
            (uri.getPort()!=-1 && uri.getPort()!=443) ||
            !Arrays.asList("image.mangabz.com","cover.mangabz.com").contains(uri.getHost()))
            throw new IOException("图片地址无效");
        // The CDN identifies each page by its path; key/cid/uk are expiring access signatures.
        byte[] hash=MessageDigest.getInstance("SHA-256").digest((uri.getHost()+uri.getRawPath()).getBytes(StandardCharsets.UTF_8));
        StringBuilder out=new StringBuilder();
        for(byte b:hash)out.append(String.format(Locale.ROOT,"%02x",b&255));
        return out.toString();
    }
    synchronized int generation() { return generation; }
    synchronized boolean contains(String url) throws Exception {return new File(directory,key(url)).isFile();}
    synchronized Image get(String url) throws Exception {
        File f=new File(directory,key(url));
        if(!f.isFile())return null;
        try(DataInputStream in=new DataInputStream(new FileInputStream(f))) {
            String mime=in.readUTF(); int length=in.readInt();
            if(!mime.startsWith("image/") || length<1 || length>MAX_IMAGE || length>f.length())throw new IOException();
            byte[] bytes=new byte[length]; in.readFully(bytes);
            f.setLastModified(System.currentTimeMillis());
            return new Image(mime,bytes);
        } catch(IOException e) { size-=f.length(); f.delete(); return null; }
    }
    synchronized boolean put(String url,Image image,int version) throws Exception {
        if(version!=generation || image.bytes.length==0 || image.bytes.length>MAX_IMAGE)return false;
        if(!directory.isDirectory()) {if(!directory.mkdirs())return false;size=0;}
        if(directory.getUsableSpace()<image.bytes.length+32L*1024*1024)return false;
        File target=new File(directory,key(url)), temp=new File(directory,target.getName()+".part");
        try {
            try(DataOutputStream out=new DataOutputStream(new FileOutputStream(temp))) {
                out.writeUTF(image.mime);out.writeInt(image.bytes.length);out.write(image.bytes);
            }
            long previous=target.length(),written=temp.length();
            if(!temp.renameTo(target))return false;
            size+=written-previous;
            // ponytail: scan only when the 512 MiB ceiling is reached; index if profiling warrants it.
            if(size>limit) {
                File[] files=directory.listFiles();
                if(files!=null) {
                    size=0;for(File f:files)size+=f.length(); // Android may evict cache files independently.
                    Arrays.sort(files,Comparator.comparingLong(File::lastModified));
                    for(File f:files) {if(size<=limit)break;long n=f.length();if(f.delete())size-=n;}
                }
            }
            return target.isFile();
        } finally {temp.delete();}
    }
    synchronized void clear() throws IOException {
        generation++; IOException failed=null;
        File[] files=directory.listFiles();
        if(files!=null)for(File f:files)if(!f.delete())failed=new IOException("缓存清理未完成");
        size=0;
        files=directory.listFiles();if(files!=null)for(File f:files)size+=f.length();
        if(failed!=null)throw failed;
    }
    static long cutoff(long now,TimeZone zone) {
        Calendar c=Calendar.getInstance(zone);c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY,3);c.set(Calendar.MINUTE,0);c.set(Calendar.SECOND,0);c.set(Calendar.MILLISECOND,0);
        if(c.getTimeInMillis()>now)c.add(Calendar.DATE,-1);
        return c.getTimeInMillis();
    }
    static long nextCleanup(long now,TimeZone zone) {
        Calendar c=Calendar.getInstance(zone);c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY,3);c.set(Calendar.MINUTE,0);c.set(Calendar.SECOND,0);c.set(Calendar.MILLISECOND,0);
        if(c.getTimeInMillis()<=now)c.add(Calendar.DATE,1);
        return c.getTimeInMillis();
    }
}

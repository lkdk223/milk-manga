package com.milkmanga.reader;
import java.io.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;

public final class ImageCacheCheck {
    static void check(boolean result,String message){if(!result)throw new AssertionError(message);}
    static long time(String text){return ZonedDateTime.parse(text).toInstant().toEpochMilli();}
    public static void main(String[] args)throws Exception{
        Path workspace=Files.createTempDirectory("manga-cache-check-");
        File folder=workspace.resolve("online-images").toFile();
        Path local=Files.write(workspace.resolve("local-book.pdf"),new byte[]{9});
        try {
            ImageCache cache=new ImageCache(folder,512);
            String a="https://image.mangabz.com/1/242/16752/1.jpg?cid=16752&key=old";
            String renewed=a.replace("old","new")+"&_retry=123";
            String b=a.replace("/1.jpg","/2.jpg");
            check(ImageCache.key(a).equals(ImageCache.key(renewed)),"Signatures must share image bytes");
            check(!ImageCache.key(a).equals(ImageCache.key(b)),"Pages must remain distinct");
            for(String bad:Arrays.asList("https://image.mangabz.com.evil.test/a","file:///a","https://image.mangabz.com@evil.test/a","https://image.mangabz.com:8443/a"))
                try{ImageCache.key(bad);throw new AssertionError("Accepted "+bad);}catch(IOException expected){}
            byte[] bytes=new byte[300];Arrays.fill(bytes,(byte)42);
            int original=cache.generation();
            check(cache.put(a,new ImageCache.Image("image/jpeg",bytes),original),"Write");
            check(Arrays.equals(cache.get(renewed).bytes,bytes),"Read after signature renewal");
            new File(folder,ImageCache.key(a)).setLastModified(1);
            check(cache.put(b,new ImageCache.Image("image/jpeg",bytes),original),"Second write");
            check(cache.get(a)==null&&cache.get(b)!=null,"Bounded LRU eviction");
            cache.clear();
            check(cache.get(b)==null,"Clear online files");
            check(!cache.put(a,new ImageCache.Image("image/jpeg",bytes),original),"In-flight download must not refill a cleared cache");
            check(Files.readAllBytes(local)[0]==9,"Never touch local books");
            check(cache.put(a,new ImageCache.Image("image/png",bytes),cache.generation()),"New reading can cache again");
            ImageCache reopened=new ImageCache(folder,512);
            check(reopened.get(a)!=null,"Persistent image bytes");
            check(new File(folder,ImageCache.key(a)).delete()&&folder.delete(),"Simulate system eviction");
            check(reopened.put(b,new ImageCache.Image("image/jpeg",bytes),reopened.generation()),"Recreate a system-evicted cache");
            TimeZone sh=TimeZone.getTimeZone("Asia/Shanghai");
            long before=time("2026-11-02T02:59:59+08:00"),at=time("2026-11-02T03:00:00+08:00");
            check(ImageCache.nextCleanup(before,sh)==at,"Next 03:00 before cutoff");
            check(ImageCache.nextCleanup(at,sh)==time("2026-11-03T03:00:00+08:00"),"03:00 reschedules tomorrow");
            check(ImageCache.cutoff(before,sh)==time("2026-11-01T03:00:00+08:00"),"No premature cleanup");
            check(ImageCache.cutoff(at,sh)==at,"Startup catch-up becomes due at 03:00");
            TimeZone ny=TimeZone.getTimeZone("America/New_York");
            long dst=time("2026-03-07T03:00:00-05:00");
            check(ImageCache.nextCleanup(dst,ny)-dst==23L*60*60*1000,"Use local calendar across DST");
            System.out.println("PASS: persistent signed-image reuse, trust boundary, LRU ceiling, clear/write race, local-file preservation, 03:00 cutoff/catch-up and DST");
        } finally {
            try(java.util.stream.Stream<Path> paths=Files.walk(workspace)){paths.sorted(Comparator.reverseOrder()).forEach(p->{try{Files.delete(p);}catch(IOException e){throw new UncheckedIOException(e);}});}
        }
    }
}

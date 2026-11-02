package com.milkmanga.reader;
import java.io.*;
import java.nio.charset.Charset;
import java.util.*;
import java.util.zip.*;
public final class LocalBookCheck {
  public static void main(String[] args) throws Exception {
    List<String> names=new ArrayList<>(Arrays.asList("10.jpg","2.jpg","1.jpg","chapter10/1.png","chapter2/1.png"));names.sort(LocalBooks::naturalCompare);
    if(!names.equals(Arrays.asList("1.jpg","2.jpg","10.jpg","chapter2/1.png","chapter10/1.png")))throw new AssertionError(names);
    File file=File.createTempFile("local-comic-check-",".zip");
    try {
      try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(file))){for(String name:Arrays.asList("10.jpg","2.jpg","1.jpg","../escape.jpg","__MACOSX/._cover.jpg","readme.txt")){out.putNextEntry(new ZipEntry(name));out.write(new byte[]{1});out.closeEntry();}}
      try(ZipFile zip=new ZipFile(file)){if(!LocalBooks.zipImages(zip).equals(Arrays.asList("1.jpg","2.jpg","10.jpg")))throw new AssertionError("Unsafe or non-image entries included");}
      try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(file),Charset.forName("GB18030"))){out.putNextEntry(new ZipEntry("中文漫画/第2页.jpg"));out.write(1);out.closeEntry();}
      try(ZipFile zip=LocalBooks.openZip(file)){if(!LocalBooks.zipImages(zip).equals(Arrays.asList("中文漫画/第2页.jpg")))throw new AssertionError("GB18030 ZIP names");}
    }finally{file.delete();}
    String text="最新：第12话，10月22号";
    if(!MainActivity.decode(text.getBytes("UTF-8"),"text/html; charset=utf-8").equals(text))throw new AssertionError("UTF8");
    if(!MainActivity.decode(text.getBytes("GB18030"),"text/html; charset=utf-8").equals(text))throw new AssertionError("Mislabeled GB18030");
    System.out.println("PASS: image natural order, safe ZIP inventory, and UTF8/GB18030 update text decoding. Android picker and PDF rendering require device testing.");
  }
}

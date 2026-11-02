package com.milkmanga.reader;
public final class OriginCheck {
    public static void main(String[] args) {
        String[] valid = {"https://www.mangabz.com/38bz/", "https://image.mangabz.com/1/38/a.jpg", "https://cover.mangabz.com/a.jpg?x=1"};
        String[] invalid = {"http://www.mangabz.com/", "https://mangabz.com.evil.test/", "https://evil.test/mangabz.com", "https://www.mangabz.com@127.0.0.1/", "https://www.mangabz.com:8443/", "file:///sdcard/a", "https://127.0.0.1/", "javascript:alert(1)"};
        for (String url : valid) if (!MainActivity.allowed(url)) throw new AssertionError(url);
        for (String url : invalid) if (MainActivity.allowed(url)) throw new AssertionError(url);
        System.out.println("PASS: trusted HTTPS resources accepted; lookalike domains, userinfo, cleartext, files, private hosts and alternate ports rejected");
    }
}

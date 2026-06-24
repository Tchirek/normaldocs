# LibreOffice Portable resource

NormalDocs does not commit LibreOffice binaries. Windows release builds may place LibreOffice Portable at:

```text
vendor/libreoffice/win/LibreOfficePortable/App/libreoffice/program/soffice.exe
```

The daemon uses this bundled executable only for PPT/PPTX and legacy Office fallbacks. PDF, DOCX and XLSX previews use bundled JavaScript libraries instead.

When shipping a build with LibreOffice, include the LibreOffice MPL/LGPL license notices and a source offer/link for the exact LibreOffice build used.

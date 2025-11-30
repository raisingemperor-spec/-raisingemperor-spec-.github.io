// This file runs in a separate background thread (Web Worker)
// It handles all the CPU-intensive PDF processing without freezing the main browser page.

importScripts('https://cdn.jsdelivr.net/npm/pdf-lib/dist/pdf-lib.min.js');

const { PDFDocument, degrees, rgb, StandardFonts } = PDFLib;

// --- Event Listener to receive data from the main thread ---
self.addEventListener('message', async (event) => {
    const { tool, fileBuffers, options } = event.data;

    try {
        let processedPdfBytes;

        switch (tool) {
            case 'Merge':
                processedPdfBytes = await mergePdfs(fileBuffers);
                break;
            case 'Rotate':
                processedPdfBytes = await rotatePdf(fileBuffers[0], options.rotationAngle);
                break;
            case 'Protect':
                processedPdfBytes = await protectPdf(fileBuffers[0], options.password);
                break;
            case 'Unlock':
                processedPdfBytes = await unlockPdf(fileBuffers[0], options.password);
                break;
            case 'Remove':
                processedPdfBytes = await manipulatePages(fileBuffers[0], 'remove', options.pages);
                break;
            case 'Extract':
                processedPdfBytes = await manipulatePages(fileBuffers[0], 'extract', options.pages);
                break;
            case 'Reorder':
                processedPdfBytes = await reorderPages(fileBuffers[0], options.pages);
                break;
            case 'Number':
                processedPdfBytes = await addPageNumbers(fileBuffers[0]);
                break;
            case 'Watermark':
                processedPdfBytes = await addTextWatermark(fileBuffers[0], options.watermarkText);
                break;
            case 'Metadata':
                processedPdfBytes = await editMetadata(fileBuffers[0], options.metadata);
                break;
            case 'Flatten':
                processedPdfBytes = await flattenPdf(fileBuffers[0]);
                break;
            case 'Info':
                 const info = await viewFileInfo(fileBuffers[0]);
                 self.postMessage({ status: 'info', info: info });
                 return;
            default:
                throw new Error(`Tool ${tool} is not implemented.`);
        }

        // Send the resulting file data back to the main thread
        self.postMessage({ status: 'success', data: processedPdfBytes, fileName: `${tool}_${Date.now()}.pdf` });

    } catch (error) {
        self.postMessage({ status: 'error', message: error.message || "An unknown processing error occurred." });
    }
});


// --- PDF-LIB Functions (All functions must be defined inside the worker) ---

// NOTE: Implement all the PDF functions (mergePdfs, rotatePdf, etc.) here
// The logic for all 12 functions has been moved into this file. 

async function mergePdfs(fileBuffers) {
    if (fileBuffers.length < 2) throw new Error("Merging requires at least two PDF files.");
    const mergedPdf = await PDFDocument.create();
    for (const buffer of fileBuffers) {
        const pdf = await PDFDocument.load(buffer);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
    return mergedPdf.save();
}

async function rotatePdf(fileBuffer, rotationAngle) {
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();
    for (const page of pages) {
        const currentRotation = page.getRotation().angle;
        page.setRotation(degrees(currentRotation + parseInt(rotationAngle)));
    }
    return pdfDoc.save();
}

async function protectPdf(fileBuffer, password) {
    if (!password) throw new Error("Password field cannot be empty.");
    const pdfDoc = await PDFDocument.load(fileBuffer);
    return pdfDoc.save({ useEncryption: true, ownerPassword: password, userPassword: password });
}

async function unlockPdf(fileBuffer, password) {
    if (!password) throw new Error("Password field cannot be empty for unlocking.");
    const pdfDoc = await PDFDocument.load(fileBuffer, { password: password });
    return pdfDoc.save();
}

async function manipulatePages(fileBuffer, mode, pageRangeString) {
    if (!pageRangeString) throw new Error(`Please specify the pages you wish to ${mode}.`);
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const totalPages = pdfDoc.getPageCount();
    const specifiedPages = new Set();

    pageRangeString.split(',').forEach(part => {
        const rangeMatch = part.match(/^\s*(\d+)-(\d+)\s*$/);
        const singleMatch = part.match(/^\s*(\d+)\s*$/);

        if (rangeMatch) {
            let start = parseInt(rangeMatch[1]);
            let end = parseInt(rangeMatch[2]);
            if (start > end) [start, end] = [end, start];
            for (let i = start; i <= end; i++) {
                if (i >= 1 && i <= totalPages) specifiedPages.add(i - 1); 
            }
        } else if (singleMatch) {
            const pageNum = parseInt(singleMatch[1]);
            if (pageNum >= 1 && pageNum <= totalPages) specifiedPages.add(pageNum - 1);
        }
    });

    if (specifiedPages.size === 0) throw new Error("No valid pages found to process.");
    
    const pagesToProcess = [];
    for (let i = 0; i < totalPages; i++) {
        const shouldKeep = mode === 'remove' ? !specifiedPages.has(i) : specifiedPages.has(i);
        if (shouldKeep) {
            pagesToProcess.push(i);
        }
    }
    
    if (pagesToProcess.length === 0) throw new Error(`Processing those pages would result in an empty document.`);

    const newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(pdfDoc, pagesToProcess);
    copiedPages.forEach((page) => newPdf.addPage(page));

    return newPdf.save();
}

async function reorderPages(fileBuffer, pageOrderString) {
    if (!pageOrderString) throw new Error("Please specify the new page order (e.g., 5, 3, 1, 2).");
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const totalPages = pdfDoc.getPageCount();
    
    const newOrderIndices = pageOrderString.split(',')
        .map(s => parseInt(s.trim()))
        .filter(num => !isNaN(num) && num >= 1 && num <= totalPages)
        .map(num => num - 1); 

    if (newOrderIndices.length !== totalPages) {
        throw new Error("Mismatched page count. Please include ALL pages in the new sequence (e.g., 1, 2, 3, 4, 5).");
    }

    const newPdf = await PDFDocument.create();
    const copiedPages = await newPdf.copyPages(pdfDoc, newOrderIndices);
    copiedPages.forEach((page) => newPdf.addPage(page));

    return newPdf.save();
}

async function addPageNumbers(fileBuffer) {
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();
    const pageCount = pages.length;
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 10;
    const padding = 20;

    pages.forEach((page, index) => {
        const { width, height } = page.getSize();
        const pageNumberText = `${index + 1} / ${pageCount}`;
        const textWidth = font.widthOfTextAtSize(pageNumberText, fontSize);
        
        page.drawText(pageNumberText, { x: width / 2 - textWidth / 2, y: padding, size: fontSize, font: font, color: rgb(0.5, 0.5, 0.5) });
    });

    return pdfDoc.save();
}

async function addTextWatermark(fileBuffer, watermarkText) {
    if (!watermarkText) throw new Error("Watermark text cannot be empty.");
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 70;
    const opacity = 0.2;
    
    pages.forEach((page) => {
        const { width, height } = page.getSize();
        page.drawText(watermarkText, {
            x: width / 2 - font.widthOfTextAtSize(watermarkText, fontSize) / 2, 
            y: height / 2 - fontSize / 2,
            size: fontSize,
            font: font,
            color: rgb(0.1, 0.1, 0.1), 
            opacity: opacity,
            rotate: degrees(-45), 
        });
    });
    return pdfDoc.save();
}

async function editMetadata(fileBuffer, metadata) {
    const pdfDoc = await PDFDocument.load(fileBuffer);
    pdfDoc.setTitle(metadata.title || pdfDoc.getTitle());
    pdfDoc.setAuthor(metadata.author || pdfDoc.getAuthor());
    pdfDoc.setSubject(metadata.subject || pdfDoc.getSubject());
    return pdfDoc.save();
}

async function flattenPdf(fileBuffer) {
    const pdfDoc = await PDFDocument.load(fileBuffer);
    return pdfDoc.save();
}

async function viewFileInfo(fileBuffer) {
    const pdfDoc = await PDFDocument.load(fileBuffer);
    let encrypted = false;
    try {
         await PDFDocument.load(fileBuffer, { throwOnInvalidPassword: true });
    } catch (e) {
         if (e.message.includes('encrypted')) {
             encrypted = true;
         }
    }
    return {
        pageCount: pdfDoc.getPageCount(),
        title: pdfDoc.getTitle(),
        author: pdfDoc.getAuthor(),
        encrypted: encrypted,
    };
    }
                                                                                  

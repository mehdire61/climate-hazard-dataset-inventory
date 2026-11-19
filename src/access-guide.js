/* Human next steps for prepared routes. This module never contacts a provider. */
(function(root){
  'use strict';
  const launchers={windows:'py -3',unix:'python3',path:'python'};
  const pythonURL='https://www.python.org/downloads/';
  function forPlan(profile,plan,platform='windows') {
    if(!plan||plan.errors?.length)return null;
    const id=profile.productId,script=plan.artifacts?.find(a=>a.role==='request'&&a.name.endsWith('.py'));
    const interpreter=launchers[platform];if(!interpreter)throw new Error('Choose a supported Python command.');
    const direct=profile.kind==='files',external=profile.kind==='external';
    const guide={title:external?'Continue with the provider':direct?'Download the provider files':profile.strategy==='mrms'?'Find files, then download':'Get data with Python',
      direct,external,scriptName:script?.name||null,providerUrl:profile.providerUrl,docsUrl:profile.docsUrl,
      steps:[],requirements:[],commands:[],links:[],result:'',remainingChoices:external?(profile.requiredSelections||[]):[]};
    if(external){
      guide.steps=[...(profile.steps||[])];
      if(id==='fathom_gfm3')guide.steps[2]='Use your licensed provider account or contact to request the chosen layer and project area. The saved JSON is for your records; it is not a provider submission format.';
      guide.requirements=[profile.auth];
      guide.result='The selected provider files or a submitted provider request. This tool cannot confirm completion inside the provider website.';
      return guide;
    }
    if(direct){
      guide.steps=['Choose a file below after checking its dates, size and access terms.','Use Download / open data. The provider may download the file, display it in the browser, or ask you to sign in. If displayed, use your browser’s Save as command.','Keep the original file and inspect its metadata and quality flags before using it. Whole archives and tiles still need any project-specific processing.'];
      guide.result='Original provider files in your browser’s download location. No Python or JSON request file is needed for these links.';
      if(profile.strategy==='cmr')guide.links.push({label:'Earthdata sign-in and download help',url:'https://www.earthdata.nasa.gov/data/earthdata-login'});
      if(!script)return guide;
    }
    if(!script)return guide;
    const cmd=interpreter+' '+script.name;
    if(profile.strategy==='mrms')guide.providerUrl='https://noaa-mrms-pds.s3.amazonaws.com/index.html';
    guide.requirements=['Python 3.10 or later installed on your computer. If the command is not found, install Python and reopen your terminal.'];
    guide.links.push({label:'Get Python',url:pythonURL});
    guide.commands.push({label:'Check Python',text:interpreter+' --version'});
    if(profile.strategy==='cds'){
      const lake=id==='c3s_lake_water_level';
      guide.requirements.push('A CDS account, accepted terms for '+(lake?'satellite lake water levels':'ERA5 single levels')+', and your own local CDS personal access token configured using the official setup page. The inventory never asks for the token.');
      guide.links.push({label:'Set up your CDS account and API access',url:'https://cds.climate.copernicus.eu/how-to-api'},
        {label:lake?'Accept terms / use the lake download form':'Accept terms / use the ERA5 web form',url:profile.providerUrl.split('?')[0]+'?tab=download'});
      guide.commands.push({label:'Install the CDS client once',text:interpreter+' -m pip install "cdsapi>=0.7.7"'});
    }else guide.requirements.push('No extra Python packages are needed for this script. '+profile.auth);
    guide.commands.push({label:'Preview the request (no download)',text:cmd});
    const flag=['cds','mrms'].includes(profile.strategy)?'--execute':'--download';
    guide.requiresTransferChoice=direct?plan.manifest?.transferSummary?.requiresConfirmation===true:['cds','daily-template','ims-daily-template','erddap'].includes(profile.strategy);
    if(!guide.requiresTransferChoice)guide.commands.push({label:profile.strategy==='mrms'?'Find the available files':'Download data after reviewing the preview',text:cmd+' '+flag});
    if(profile.strategy==='mrms')guide.commands.push({label:'Download one file after checking the listing',text:cmd+' --download --file 1'});
    if(direct||['erddap','mrms','cds','daily-template','ims-daily-template'].includes(profile.strategy)){
      guide.transferNote='The script reports the selected total before transfer. At least 1 GB, more than 100 files, or uncertain file sizes require --confirm-transfer. Choose individual file numbers, repeat --file for a selection, or explicitly confirm all files. There is no overall size or file-count cap; no large batch starts by default.';
      if(profile.strategy==='cds')guide.transferNote='The preview reports the prepared monthly request count; compressed output size is unknown until CDS prepares the files. Choose request numbers with --request N, or explicitly confirm the full prepared period. --execute requires --confirm-transfer before submitting jobs. There is no overall size or request-count cap.';
      const execute=profile.strategy==='cds'?'--execute':'--download',selection=profile.strategy==='cds'?'--request':'--file';
      guide.confirmationCommand={label:'Only after reviewing this selection’s size and extent',text:cmd+' '+execute+' '+selection+' 1 --confirm-transfer'};
      guide.confirmAllCommand={label:'Request all selected data after reviewing the total',text:cmd+' '+execute+' --confirm-transfer'};
    }
    guide.scriptSteps=['Download the Python script below into a folder you can find again. You do not need the optional JSON files.',
      'Open a terminal in that folder. On Windows, open the folder in File Explorer and use Open in Terminal; on macOS/Linux, open Terminal and use cd to enter the folder.',
      'Check Python and complete the setup below. Run the preview command first and inspect the product, dates and spatial extent.',
      'After the preview, choose one file/request, selected numbers, or the full batch using the download choices below. Leave the terminal open and read any provider error before retrying.'];
    if(direct)guide.scriptSteps.push('Without --file, the download command selects all '+plan.files.length+' listed files. Add --file N using the one-based preview numbers to select individual files; repeat --file for several. Large or uncertain-size selections stop before transfer unless you explicitly confirm them.');
    guide.scriptResult=profile.strategy==='cds'?id+'_data/: '+(id==='c3s_lake_water_level'?'the provider lake file':'GRIB files')+' and retrieval-manifest.json. CDS may queue the request. Authenticated retrieval has not been tested.'
      :profile.strategy==='mrms'?id+'_file-links.html and JSON manifest: --execute only lists files. --download retrieves selected original GRIB2 gzip files with transfer receipts; use --file N to avoid a large whole-period batch. Incomplete listings and transfers remain explicitly labelled.'
      :profile.strategy==='coolr-arcgis'?'coolr_provider_features/: dated coolr-*.geojson and receipt files. Unknown event dates remain included; geometries are candidates, not clipped to the project.'
      :id+'_provider_files/: original provider files and transfer receipts. A .part file or failed receipt is an incomplete transfer, not usable data.';
    if(id==='c3s_lake_water_level')guide.transferNote='CDS supplies the complete record for the selected lake. The file size is unknown until delivery. Inspect the dates, height reference and uncertainty in the NetCDF file.';
    if(!direct){guide.steps=guide.scriptSteps;guide.result=guide.scriptResult;}
    return guide;
  }
  function text(guide,project){
    return [guide.title,'',project,'',...(!guide.direct?guide.requirements:[]),...guide.steps.map((s,i)=>(i+1)+'. '+s),'',guide.result,
      ...(guide.direct&&guide.scriptName?['','Optional Python route:',...guide.requirements,...guide.scriptSteps,guide.scriptResult]:[]),
      '',...guide.commands.map(c=>c.label+'\n'+c.text),...(guide.transferNote?['',guide.transferNote,'Optional explicit confirmation for one file:',guide.confirmationCommand.text,'Or confirm the full batch:',guide.confirmAllCommand.text]:[]),
      ...(guide.remainingChoices.length?['','Still to select:',...guide.remainingChoices]:[]),
      '',...guide.links.map(l=>l.label+': '+l.url),'Provider: '+guide.providerUrl,'Documentation: '+guide.docsUrl].join('\n')+'\n';
  }
  root.SiteAccessGuide={forPlan,text};if(typeof module==='object'&&module.exports)module.exports=root.SiteAccessGuide;
})(typeof globalThis!=='undefined'?globalThis:this);
